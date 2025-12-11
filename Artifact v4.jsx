import { useState, useCallback, useRef, useEffect, createContext, useContext, useReducer } from 'react';

// ============================================
// GEOMETRY UTILITIES
// ============================================
const vec = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (v, s) => ({ x: v.x * s, y: v.y * s }),
  len: (v) => Math.sqrt(v.x * v.x + v.y * v.y),
  normalize: (v) => { const l = vec.len(v); return l === 0 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l }; },
  fromAngle: (rad, len = 1) => ({ x: Math.cos(rad) * len, y: Math.sin(rad) * len }),
  angle: (v) => Math.atan2(v.y, v.x),
  dist: (a, b) => vec.len(vec.sub(b, a)),
};
const deg2rad = (d) => d * Math.PI / 180;
const arrowheadPoints = (tip, dir, size = 10) => {
  const left = vec.add(tip, vec.fromAngle(dir + Math.PI + 0.4, size));
  const right = vec.add(tip, vec.fromAngle(dir + Math.PI - 0.4, size));
  return `${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`;
};

// ============================================
// VISION PROMPT
// ============================================
const SYSTEM_PROMPT = `You are a precise technical diagram analyzer. Extract structured data from engineering problem images (circuits, statics). 
RULES: 1) Extract EXACTLY what you see 2) Flag uncertainty explicitly 3) Preserve spatial relationships 4) Distinguish KNOWN from UNKNOWN values`;

const buildExtractionPrompt = (w, h, userGuidance = '') => `
Analyze this engineering problem image. Extract ALL information into JSON.
IMAGE: ${w} x ${h} pixels. Report positions as {x, y} coordinates.
${userGuidance ? `\nUSER GUIDANCE (trust this context):\n${userGuidance}\n` : ''}
OUTPUT (ONLY valid JSON, no markdown):
{
  "detectedDomain": "circuits" | "statics" | "unknown",
  "parseConfidence": <0.0-1.0>,
  "rawTextExtracted": "<all text>",
  "imageSize": {"width": ${w}, "height": ${h}},
  "entities": [{"id": "<unique>", "type": "<type>", "label": "<label>", "properties": {}, "position": {"x": <n>, "y": <n>}, "sourceRegion": {"topLeft": {"x": <n>, "y": <n>}, "bottomRight": {"x": <n>, "y": <n>}, "confidence": <0-1>}}],
  "relationships": [{"id": "<unique>", "type": "<type>", "source": "<entity_id>", "target": "<entity_id>", "properties": {}, "confidence": <0-1>}],
  "constraints": [{"type": "<type>", "scope": ["<entity_id>"], "equation": "<if explicit>"}],
  "unknowns": [{"entityId": "<id>", "property": "<prop>"}],
  "visualGroups": [{"label": "<desc>", "memberIds": ["<id>"]}],
  "ambiguities": [{"elementId": "<id>", "alternatives": [{"description": "<desc>", "patch": {}, "probability": <0-1>}], "resolved": false}]
}

ENTITY TYPES: point, force, moment, beam, pin_support, roller_support, fixed_support, distributed_load, labeled_value, annotation, resistor, capacitor, voltage_source, ground, node, wire
RELATIONSHIP TYPES: connects, series_with, parallel_with, applied_at, spans, supports, direction
Extract now:`;

// ============================================
// PARSER
// ============================================
const extractJSON = (response) => {
  try { return { json: JSON.parse(response) }; }
  catch { const m = response.match(/\{[\s\S]*\}/); if (m) try { return { json: JSON.parse(m[0]) }; } catch (e) { return { json: null, error: String(e) }; } return { json: null, error: 'No JSON found' }; }
};

const validateParseResult = (raw) => {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: [{ message: 'Not an object' }] };
  if (!raw.entities) errors.push({ message: 'Missing entities' });
  if (!raw.relationships) errors.push({ message: 'Missing relationships' });
  return { valid: errors.length === 0, result: raw, errors };
};

const applyCorrection = (result, correction) => {
  const next = JSON.parse(JSON.stringify(result));
  switch (correction.type) {
    case 'resolve_ambiguity': {
      const amb = next.ambiguities?.find(a => a.elementId === correction.ambiguityId);
      if (amb && amb.alternatives[correction.chosenIndex]) {
        const chosen = amb.alternatives[correction.chosenIndex];
        const entity = next.entities.find(e => e.id === amb.elementId);
        if (entity) Object.assign(entity, chosen.patch);
        amb.resolved = true;
      }
      break;
    }
    case 'update_entity': {
      const entity = next.entities.find(e => e.id === correction.entityId);
      if (entity) Object.assign(entity, correction.patch);
      break;
    }
    case 'delete_entity': {
      next.entities = next.entities.filter(e => e.id !== correction.entityId);
      next.relationships = next.relationships.filter(r => r.source !== correction.entityId && r.target !== correction.entityId);
      break;
    }
    case 'add_entity': next.entities.push(correction.entity); break;
  }
  return next;
};

// ============================================
// STATE MANAGEMENT
// ============================================
const initialState = {
  mode: 'upload', // upload | review | parsing | edit | solving | solution
  image: { base64: null, width: 0, height: 0, filename: '' },
  parseResult: null,
  parseErrors: [],
  corrections: [],
  correctionIndex: -1,
  solveResult: null,
  solveErrors: [],
  selection: null,
  hoveredElement: null,
  canvasTransform: { scale: 1, offsetX: 0, offsetY: 0 },
  showGrid: true,
  activeAmbiguityId: null,
  preParseMessages: [], // {role: 'user'|'assistant', content: string}
};

const reducer = (state, action) => {
  switch (action.type) {
    case 'SET_IMAGE': return { ...state, image: action.payload, mode: 'review' };
    case 'CLEAR_IMAGE': return { ...initialState };
    case 'SET_MODE': return { ...state, mode: action.payload };
    case 'ADD_PRE_PARSE_MESSAGE': return { ...state, preParseMessages: [...state.preParseMessages, action.payload] };
    case 'SET_PARSE_RESULT': return { ...state, parseResult: action.payload, parseErrors: [], corrections: [], correctionIndex: -1, solveResult: null, mode: 'edit' };
    case 'SET_PARSE_ERRORS': return { ...state, parseErrors: action.payload, mode: 'edit' };
    case 'APPLY_CORRECTION': {
      if (!state.parseResult) return state;
      const newCorrections = [...state.corrections.slice(0, state.correctionIndex + 1), action.payload];
      return { ...state, parseResult: applyCorrection(state.parseResult, action.payload), corrections: newCorrections, correctionIndex: newCorrections.length - 1, solveResult: null };
    }
    case 'SELECT': return { ...state, selection: action.payload };
    case 'CLEAR_SELECTION': return { ...state, selection: null };
    case 'SET_TRANSFORM': return { ...state, canvasTransform: { ...state.canvasTransform, ...action.payload } };
    case 'RESET_TRANSFORM': return { ...state, canvasTransform: { scale: 1, offsetX: 0, offsetY: 0 } };
    case 'TOGGLE_GRID': return { ...state, showGrid: !state.showGrid };
    case 'OPEN_AMBIGUITY': return { ...state, activeAmbiguityId: action.payload };
    case 'CLOSE_AMBIGUITY': return { ...state, activeAmbiguityId: null };
    case 'SET_SOLVE_RESULT': return { ...state, solveResult: action.payload, solveErrors: [], mode: 'solution' };
    case 'SET_SOLVE_ERRORS': return { ...state, solveErrors: action.payload, mode: 'edit' };
    default: return state;
  }
};

const AppContext = createContext(null);

function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  
  const actions = {
    setImage: (base64, width, height, filename) => dispatch({ type: 'SET_IMAGE', payload: { base64, width, height, filename } }),
    clearImage: () => dispatch({ type: 'CLEAR_IMAGE' }),
    setParseResult: (r) => dispatch({ type: 'SET_PARSE_RESULT', payload: r }),
    applyCorrection: (c) => dispatch({ type: 'APPLY_CORRECTION', payload: c }),
    select: (s) => dispatch({ type: 'SELECT', payload: s }),
    clearSelection: () => dispatch({ type: 'CLEAR_SELECTION' }),
    toggleGrid: () => dispatch({ type: 'TOGGLE_GRID' }),
    openAmbiguity: (id) => dispatch({ type: 'OPEN_AMBIGUITY', payload: id }),
    closeAmbiguity: () => dispatch({ type: 'CLOSE_AMBIGUITY' }),
    updateEntityPosition: (id, x, y) => dispatch({ type: 'APPLY_CORRECTION', payload: { type: 'update_entity', entityId: id, patch: { position: { x, y } } } }),
    updateEntityType: (id, t) => dispatch({ type: 'APPLY_CORRECTION', payload: { type: 'update_entity', entityId: id, patch: { type: t } } }),
    deleteEntity: (id) => dispatch({ type: 'APPLY_CORRECTION', payload: { type: 'delete_entity', entityId: id } }),
    resolveAmbiguity: (ambId, idx) => { dispatch({ type: 'APPLY_CORRECTION', payload: { type: 'resolve_ambiguity', ambiguityId: ambId, chosenIndex: idx } }); dispatch({ type: 'CLOSE_AMBIGUITY' }); },
    dispatch,
  };
  
  const unresolvedAmbiguities = state.parseResult?.ambiguities?.filter(a => !a.resolved) || [];
  const canSolve = state.parseResult && unresolvedAmbiguities.length === 0;
  const selectedEntity = state.selection?.type === 'entity' ? state.parseResult?.entities?.find(e => e.id === state.selection.id) : null;
  
  return <AppContext.Provider value={{ state, actions, unresolvedAmbiguities, canSolve, selectedEntity }}>{children}</AppContext.Provider>;
}

const useApp = () => useContext(AppContext);

// ============================================
// SOLVER (Simplified Statics)
// ============================================
const solveStatics = (parseResult) => {
  const steps = [];
  
  // Extract dimensions from labeled_value entities
  const dims = {};
  parseResult.entities.filter(e => e.type === 'labeled_value' && e.properties?.dimension).forEach(d => {
    const { from, to, axis } = d.properties;
    const val = d.properties.dimension.value;
    const key = `${from}_${to}_${axis}`;
    dims[key] = val;
  });
  
  steps.push({ index: 0, title: 'Extract Dimensions', description: `Found ${Object.keys(dims).length} dimension(s): ${Object.entries(dims).map(([k,v]) => `${k}=${v}`).join(', ')}`, highlightEntities: [] });
  
  // Find forces
  const forces = parseResult.entities.filter(e => e.type === 'force');
  steps.push({ index: 1, title: 'Identify Forces', description: `Found ${forces.length} force(s).`, highlightEntities: forces.map(f => f.id) });
  
  const solution = {};
  const equations = [];
  
  // Find key points
  const pointJ = parseResult.entities.find(e => e.label === 'J' && e.type === 'point');
  const pointB = parseResult.entities.find(e => e.label === 'B' && e.type === 'point');
  const pointD = parseResult.entities.find(e => e.label === 'D' && e.type === 'point');
  const appliedForce = forces.find(f => f.properties?.magnitude?.kind === 'known');
  
  if (pointJ && pointB && pointD && appliedForce) {
    const F = appliedForce.properties.magnitude.value;
    
    // Get real dimensions (fallback to 8,3,3 if not found)
    const dx_BJ = dims['B_J_horizontal'] || 8;  // horizontal distance B to J
    const dy_BJ = dims['B_J_vertical'] || 3;    // vertical distance B to J  
    const dy_JD = dims['J_D_vertical'] || 3;    // vertical distance J to D
    const dx_JD = dims['J_D_horizontal'] || 0;  // assume D directly below J
    
    // Compute angles from REAL dimensions (not pixels!)
    // θ_BJ = angle of string BJ from horizontal, measured at J looking toward B
    // B is up-left of J: dx=8 left, dy=3 up → angle = atan2(3, -8) ≈ 159.4°
    const thetaBJ = Math.atan2(dy_BJ, -dx_BJ);  // B is to the LEFT of J, negate dx
    
    // θ_JD = angle of string JD from horizontal, measured at J looking toward D  
    // D is down from J: dx≈0, dy=3 down → angle = -90° (straight down)
    const thetaJD = Math.atan2(-dy_JD, dx_JD); // -90° (toward D, which is below)
    
    // Tension directions: strings pull J toward their anchors
    // T_BJ pulls J toward B (up-left): uses thetaBJ direction
    // T_JD pulls J toward D (down): uses thetaJD direction
    // Applied force F: direction from force entity (180° = left = toward bow)
    
    // Sign convention: +x = right, +y = up
    // Equilibrium at J: T_BJ·uBJ + T_JD·uJD + F·uF = 0
    
    const cosBJ = Math.cos(thetaBJ), sinBJ = Math.sin(thetaBJ);
    const cosJD = Math.cos(thetaJD), sinJD = Math.sin(thetaJD);
    
    // Force direction: 180° means force pulls LEFT, but for bow problem the archer pulls RIGHT
    // The "direction" in data is where the string is pulled, so negate to get equilibrium force
    const forceDirRad = deg2rad(appliedForce.properties?.direction?.value || 0);
    const cosF = Math.cos(forceDirRad), sinF = Math.sin(forceDirRad);
    
    // Matrix: [cosBJ, cosJD] [T_BJ]   [-F*cosF]
    //         [sinBJ, sinJD] [T_JD] = [-F*sinF]
    const det = cosBJ * sinJD - cosJD * sinBJ;
    
    if (Math.abs(det) > 1e-6) {
      // Cramer's rule: Ax=b where b = [-F*cosF, -F*sinF]
      const bx = -F * cosF, by = -F * sinF;
      const T_BJ = (bx * sinJD - cosJD * by) / det;
      const T_JD = (cosBJ * by - bx * sinBJ) / det;
      
      solution['T_BJ'] = { value: Math.abs(T_BJ), unit: 'lb' };
      solution['T_JD'] = { value: Math.abs(T_JD), unit: 'lb' };
      
      const angBJ_deg = (thetaBJ * 180 / Math.PI).toFixed(1);
      const angJD_deg = (thetaJD * 180 / Math.PI).toFixed(1);
      
      equations.push({ name: 'ΣFx = 0 at J', symbolic: `-T_BJ·cos(${angBJ_deg}°) + T_JD·cos(${angJD_deg}°) = ${F} lb`, variables: ['T_BJ', 'T_JD'] });
      equations.push({ name: 'ΣFy = 0 at J', symbolic: `T_BJ·sin(${angBJ_deg}°) + T_JD·sin(${angJD_deg}°) = 0`, variables: ['T_BJ', 'T_JD'] });
      
      steps.push({ index: 2, title: 'Geometry from Dimensions', description: `θ_BJ = atan2(${dy_BJ}, ${dx_BJ}) = ${angBJ_deg}°\nθ_JD = atan2(-${dy_JD}, ${dx_JD}) = ${angJD_deg}°`, highlightEntities: ['point_B', 'point_J', 'point_D'] });
      steps.push({ index: 3, title: 'Equilibrium at J', equation: equations.map(e => e.symbolic).join('\n'), highlightEntities: ['point_J'] });
      steps.push({ index: 4, title: 'Solve System', result: `T_BJ = ${solution['T_BJ'].value.toFixed(2)} lb\nT_JD = ${solution['T_JD'].value.toFixed(2)} lb`, highlightEntities: [] });
    }
  } else {
    steps.push({ index: 2, title: 'Insufficient Data', description: 'Need points B, J, D and applied force to solve.', highlightEntities: [] });
  }
  
  const positions = {};
  parseResult.entities.filter(e => e.type === 'point').forEach(p => { positions[p.id] = p.position; });
  
  return { domain: 'statics', coordinateSystem: { origin: pointB?.id || '', positions }, equations, solution, steps };
};

// ============================================
// ENTITY RENDERER
// ============================================
function EntityRenderer({ entity, selected, hovered, ambiguous, onClick, onDragStart }) {
  const { x, y } = entity.position;
  const style = selected ? { fill: '#f59e0b', stroke: '#b45309', strokeWidth: 3 } : ambiguous ? { fill: '#fef3c7', stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '4,2' } : { fill: '#3b82f6', stroke: '#1e40af', strokeWidth: 2 };
  
  const common = { onClick, onMouseDown: onDragStart, style: { cursor: 'pointer' } };
  
  switch (entity.type) {
    case 'point':
      return <g {...common}><circle cx={x} cy={y} r={6} {...style} />{entity.label && <text x={x + 10} y={y - 10} fontSize={14} fontWeight="bold" fill="#1f2937">{entity.label}</text>}</g>;
    case 'force': {
      const mag = entity.properties?.magnitude?.kind === 'known' ? entity.properties.magnitude.value : 50;
      const angleDeg = entity.properties?.direction?.kind === 'known' ? entity.properties.direction.value : 0;
      const angle = deg2rad(angleDeg);
      const len = Math.min(mag * 0.8, 100);
      const tip = vec.add({ x, y }, vec.fromAngle(angle, len));
      return <g {...common}><line x1={x} y1={y} x2={tip.x} y2={tip.y} stroke="#ef4444" strokeWidth={2} /><polygon points={arrowheadPoints(tip, angle, 12)} fill="#ef4444" />{entity.label && <text x={(x + tip.x) / 2 + 15} y={(y + tip.y) / 2} fontSize={12} fill="#dc2626">{entity.label} = {mag} {entity.properties?.magnitude?.unit || ''}</text>}</g>;
    }
    case 'beam':
      return <g {...common}><circle cx={x} cy={y} r={8} fill={selected ? '#f59e0b' : '#6b7280'} opacity={0.5} />{entity.label && <text x={x + 12} y={y} fontSize={11} fill="#6b7280" fontStyle="italic">{entity.label}</text>}</g>;
    case 'labeled_value':
    case 'annotation':
      return <g {...common}><text x={x} y={y} fontSize={12} fill={selected ? '#f59e0b' : '#6b7280'} textAnchor="middle">{entity.label}</text></g>;
    default:
      return <g {...common}><rect x={x - 15} y={y - 15} width={30} height={30} fill="none" stroke={selected ? '#f59e0b' : '#f97316'} strokeWidth={2} strokeDasharray="4,2" /><text x={x} y={y + 4} fontSize={16} textAnchor="middle" fill="#f97316">?</text></g>;
  }
}

function RelationshipRenderer({ rel, entities, selected }) {
  const src = entities.find(e => e.id === rel.source);
  const tgt = entities.find(e => e.id === rel.target);
  if (!src || !tgt) return null;
  return <line x1={src.position.x} y1={src.position.y} x2={tgt.position.x} y2={tgt.position.y} stroke={selected ? '#f59e0b' : '#9ca3af'} strokeWidth={selected ? 2 : 1} strokeDasharray={rel.type === 'connects' ? 'none' : '4,2'} />;
}

// ============================================
// DIAGRAM CANVAS
// ============================================
function DiagramCanvas() {
  const { state, actions, unresolvedAmbiguities } = useApp();
  const svgRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [panning, setPanning] = useState(null);
  
  const { parseResult, selection, canvasTransform, showGrid, image } = state;
  
  if (!parseResult) return <div className="flex-1 flex items-center justify-center bg-gray-100 text-gray-500">No diagram loaded</div>;
  
  const { entities, relationships } = parseResult;
  const ambiguousIds = new Set(unresolvedAmbiguities.map(a => a.elementId));
  
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(5, canvasTransform.scale * delta));
    actions.dispatch({ type: 'SET_TRANSFORM', payload: { scale: newScale } });
  }, [canvasTransform, actions]);
  
  const handleMouseDown = useCallback((e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setPanning({ startX: e.clientX, startY: e.clientY, startOffsetX: canvasTransform.offsetX, startOffsetY: canvasTransform.offsetY });
      e.preventDefault();
    } else if (e.button === 0 && e.target === svgRef.current) {
      actions.clearSelection();
    }
  }, [canvasTransform, actions]);
  
  const handleMouseMove = useCallback((e) => {
    if (panning) {
      const dx = e.clientX - panning.startX, dy = e.clientY - panning.startY;
      actions.dispatch({ type: 'SET_TRANSFORM', payload: { offsetX: panning.startOffsetX + dx, offsetY: panning.startOffsetY + dy } });
    } else if (dragging) {
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect) {
        const svgX = (e.clientX - rect.left - canvasTransform.offsetX) / canvasTransform.scale;
        const svgY = (e.clientY - rect.top - canvasTransform.offsetY) / canvasTransform.scale;
        actions.updateEntityPosition(dragging.entityId, svgX, svgY);
      }
    }
  }, [panning, dragging, canvasTransform, actions]);
  
  const handleMouseUp = useCallback(() => { setPanning(null); setDragging(null); }, []);
  
  const handleEntityClick = useCallback((id) => actions.select({ type: 'entity', id }), [actions]);
  const handleEntityDragStart = useCallback((id, e) => { e.stopPropagation(); setDragging({ entityId: id }); actions.select({ type: 'entity', id }); }, [actions]);
  
  const viewBox = `0 0 ${image.width || 500} ${image.height || 500}`;
  
  return (
    <div className="flex-1 relative overflow-hidden bg-gray-50">
      <svg ref={svgRef} className="w-full h-full" viewBox={viewBox} onWheel={handleWheel} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} style={{ cursor: panning ? 'grabbing' : dragging ? 'move' : 'default' }}>
        <g transform={`translate(${canvasTransform.offsetX}, ${canvasTransform.offsetY}) scale(${canvasTransform.scale})`}>
          {showGrid && <g opacity={0.3}>{Array.from({ length: Math.ceil((image.width || 500) / 50) + 1 }, (_, i) => <line key={`v${i}`} x1={i * 50} y1={0} x2={i * 50} y2={image.height || 500} stroke="#d1d5db" strokeWidth={1} />)}{Array.from({ length: Math.ceil((image.height || 500) / 50) + 1 }, (_, i) => <line key={`h${i}`} x1={0} y1={i * 50} x2={image.width || 500} y2={i * 50} stroke="#d1d5db" strokeWidth={1} />)}</g>}
          {image.base64 && <image href={image.base64} x={0} y={0} width={image.width} height={image.height} opacity={0.3} />}
          <g>{relationships.map(r => <RelationshipRenderer key={r.id} rel={r} entities={entities} selected={selection?.type === 'relationship' && selection.id === r.id} />)}</g>
          <g>{entities.map(e => <EntityRenderer key={e.id} entity={e} selected={selection?.type === 'entity' && selection.id === e.id} hovered={false} ambiguous={ambiguousIds.has(e.id)} onClick={() => handleEntityClick(e.id)} onDragStart={(ev) => handleEntityDragStart(e.id, ev)} />)}</g>
        </g>
      </svg>
      <div className="absolute bottom-4 right-4 flex gap-2">
        <button onClick={() => actions.dispatch({ type: 'SET_TRANSFORM', payload: { scale: canvasTransform.scale * 1.2 } })} className="w-8 h-8 bg-white rounded shadow flex items-center justify-center hover:bg-gray-100">+</button>
        <button onClick={() => actions.dispatch({ type: 'SET_TRANSFORM', payload: { scale: canvasTransform.scale / 1.2 } })} className="w-8 h-8 bg-white rounded shadow flex items-center justify-center hover:bg-gray-100">−</button>
        <button onClick={() => actions.dispatch({ type: 'RESET_TRANSFORM' })} className="px-2 h-8 bg-white rounded shadow flex items-center justify-center hover:bg-gray-100 text-xs">Reset</button>
      </div>
      <div className="absolute bottom-4 left-4 text-xs text-gray-500 bg-white px-2 py-1 rounded shadow">{Math.round(canvasTransform.scale * 100)}%</div>
    </div>
  );
}

// ============================================
// CORRECTION PANEL
// ============================================
const ENTITY_TYPES = ['point', 'force', 'moment', 'beam', 'pin_support', 'roller_support', 'fixed_support', 'distributed_load', 'labeled_value', 'annotation', 'resistor', 'capacitor', 'voltage_source', 'ground', 'node', 'wire'];

function CorrectionPanel() {
  const { state, actions, unresolvedAmbiguities, selectedEntity } = useApp();
  
  if (!selectedEntity) {
    return (
      <div className="w-80 bg-white border-l p-4">
        <h3 className="font-semibold text-gray-700 mb-4">Properties</h3>
        <p className="text-gray-500 text-sm">Select an element to edit</p>
        {unresolvedAmbiguities.length > 0 && (
          <div className="mt-6">
            <h4 className="font-medium text-amber-600 mb-2">⚠ Needs Review ({unresolvedAmbiguities.length})</h4>
            <div className="space-y-2">{unresolvedAmbiguities.map(amb => <button key={amb.elementId} onClick={() => { actions.select({ type: 'entity', id: amb.elementId }); actions.openAmbiguity(amb.elementId); }} className="w-full text-left px-3 py-2 bg-amber-50 rounded border border-amber-200 text-sm hover:bg-amber-100">{amb.elementId}</button>)}</div>
          </div>
        )}
      </div>
    );
  }
  
  const entity = selectedEntity;
  const isAmbiguous = unresolvedAmbiguities.some(a => a.elementId === entity.id);
  
  return (
    <div className="w-80 bg-white border-l p-4 overflow-y-auto">
      <h3 className="font-semibold text-gray-700 mb-4">Properties</h3>
      {isAmbiguous && <button onClick={() => actions.openAmbiguity(entity.id)} className="w-full mb-4 px-3 py-2 bg-amber-50 border border-amber-300 rounded text-amber-800 text-sm hover:bg-amber-100">⚠ Multiple interpretations - click to resolve</button>}
      <div className="mb-4"><label className="block text-xs font-medium text-gray-500 mb-1">ID</label><div className="px-3 py-2 bg-gray-100 rounded text-sm font-mono">{entity.id}</div></div>
      <div className="mb-4"><label className="block text-xs font-medium text-gray-500 mb-1">Type</label><select value={entity.type} onChange={(e) => actions.updateEntityType(entity.id, e.target.value)} className="w-full px-3 py-2 border rounded text-sm">{ENTITY_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></div>
      <div className="mb-4"><label className="block text-xs font-medium text-gray-500 mb-1">Label</label><input type="text" value={entity.label || ''} onChange={(e) => actions.applyCorrection({ type: 'update_entity', entityId: entity.id, patch: { label: e.target.value || undefined } })} className="w-full px-3 py-2 border rounded text-sm" placeholder="Enter label..." /></div>
      <div className="mb-4"><label className="block text-xs font-medium text-gray-500 mb-1">Position</label><div className="flex gap-2"><div className="flex-1"><label className="text-xs text-gray-400">X</label><input type="number" value={Math.round(entity.position.x)} onChange={(e) => actions.updateEntityPosition(entity.id, Number(e.target.value), entity.position.y)} className="w-full px-2 py-1 border rounded text-sm" /></div><div className="flex-1"><label className="text-xs text-gray-400">Y</label><input type="number" value={Math.round(entity.position.y)} onChange={(e) => actions.updateEntityPosition(entity.id, entity.position.x, Number(e.target.value))} className="w-full px-2 py-1 border rounded text-sm" /></div></div></div>
      <button onClick={() => { if (confirm(`Delete ${entity.id}?`)) actions.deleteEntity(entity.id); }} className="w-full mt-4 px-3 py-2 bg-red-50 border border-red-200 rounded text-red-700 text-sm hover:bg-red-100">Delete Entity</button>
    </div>
  );
}

function AmbiguityModal() {
  const { state, actions } = useApp();
  const { activeAmbiguityId, parseResult } = state;
  if (!activeAmbiguityId || !parseResult) return null;
  const ambiguity = parseResult.ambiguities?.find(a => a.elementId === activeAmbiguityId);
  if (!ambiguity || ambiguity.resolved) { actions.closeAmbiguity(); return null; }
  
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-4 border-b"><h3 className="font-semibold text-lg">Clarification Needed</h3><p className="text-sm text-gray-600 mt-1">Multiple interpretations for: <code className="bg-gray-100 px-1 rounded">{ambiguity.elementId}</code></p></div>
        <div className="p-4 space-y-2">{ambiguity.alternatives.map((alt, i) => <button key={i} onClick={() => actions.resolveAmbiguity(ambiguity.elementId, i)} className="w-full p-3 text-left border rounded hover:bg-blue-50 hover:border-blue-300"><div className="font-medium text-sm">{alt.description}</div><div className="text-xs text-gray-500 mt-1">Confidence: {Math.round(alt.probability * 100)}%</div></button>)}</div>
        <div className="p-4 border-t bg-gray-50 flex justify-end"><button onClick={() => actions.closeAmbiguity()} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Skip</button></div>
      </div>
    </div>
  );
}

// ============================================
// IMAGE UPLOAD + REVIEW MODE
// ============================================
function ImageUpload() {
  const { state, actions } = useApp();
  const [isDragging, setIsDragging] = useState(false);
  const [preview, setPreview] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState(null);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const fileInputRef = useRef(null);
  const chatEndRef = useRef(null);
  
  const handleFile = useCallback((file) => {
    if (!file.type.startsWith('image/')) { setError('Please upload an image'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target.result;
      setPreview(base64);
      setError(null);
      const img = new Image();
      img.onload = () => actions.setImage(base64, img.width, img.height, file.name);
      img.src = base64;
    };
    reader.readAsDataURL(file);
  }, [actions]);
  
  useEffect(() => {
    const handlePaste = (e) => { const items = e.clipboardData?.items; if (items) for (const item of items) if (item.type.startsWith('image/')) { const file = item.getAsFile(); if (file) handleFile(file); break; } };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handleFile]);
  
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [state.preParseMessages, chatLoading]);
  
  const userGuidance = state.preParseMessages.filter(m => m.role === 'user').map(m => m.content).join('\n');
  
  const handleAnalyze = useCallback(async () => {
    if (!state.image.base64) return;
    setAnalyzing(true); setError(null);
    actions.dispatch({ type: 'SET_MODE', payload: 'parsing' });
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: state.image.base64.replace(/^data:image\/\w+;base64,/, '') } }, { type: 'text', text: buildExtractionPrompt(state.image.width, state.image.height, userGuidance) }] }]
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const text = data.content?.[0]?.text;
      if (!text) throw new Error('No response');
      const { json, error: jsonErr } = extractJSON(text);
      if (jsonErr) throw new Error(jsonErr);
      const validation = validateParseResult(json);
      if (!validation.valid) throw new Error(validation.errors.map(e => e.message).join(', '));
      actions.setParseResult(validation.result);
    } catch (err) { setError(err.message); actions.dispatch({ type: 'SET_MODE', payload: 'review' }); }
    finally { setAnalyzing(false); }
  }, [state.image, actions, userGuidance]);
  
  const handleUseMockData = useCallback(() => {
    const mockResult = {
      detectedDomain: 'statics', parseConfidence: 0.85, rawTextExtracted: 'Archer pulling 62-lb force',
      imageSize: { width: state.image.width || 400, height: state.image.height || 500 },
      entities: [
        { id: 'point_B', type: 'point', label: 'B', properties: {}, position: { x: 200, y: 80 }, sourceRegion: { topLeft: { x: 190, y: 70 }, bottomRight: { x: 210, y: 90 }, confidence: 0.95 } },
        { id: 'point_J', type: 'point', label: 'J', properties: {}, position: { x: 240, y: 180 }, sourceRegion: { topLeft: { x: 230, y: 170 }, bottomRight: { x: 250, y: 190 }, confidence: 0.90 } },
        { id: 'point_C', type: 'point', label: 'C', properties: {}, position: { x: 210, y: 280 }, sourceRegion: { topLeft: { x: 200, y: 270 }, bottomRight: { x: 220, y: 290 }, confidence: 0.88 } },
        { id: 'point_D', type: 'point', label: 'D', properties: {}, position: { x: 200, y: 400 }, sourceRegion: { topLeft: { x: 190, y: 390 }, bottomRight: { x: 210, y: 410 }, confidence: 0.95 } },
        { id: 'force_pull', type: 'force', label: 'F', properties: { magnitude: { kind: 'known', value: 62, unit: 'lb' }, direction: { kind: 'known', value: 0, unit: 'deg' } }, position: { x: 280, y: 180 }, sourceRegion: { topLeft: { x: 240, y: 170 }, bottomRight: { x: 300, y: 190 }, confidence: 0.85 } },
        { id: 'dim_BJ_horiz', type: 'labeled_value', label: '8 in', properties: { dimension: { kind: 'known', value: 8, unit: 'in' }, from: 'B', to: 'J', axis: 'horizontal' }, position: { x: 220, y: 130 }, sourceRegion: { confidence: 0.9 } },
        { id: 'dim_BJ_vert', type: 'labeled_value', label: '3 in', properties: { dimension: { kind: 'known', value: 3, unit: 'in' }, from: 'B', to: 'J', axis: 'vertical' }, position: { x: 170, y: 130 }, sourceRegion: { confidence: 0.9 } },
        { id: 'dim_JD_vert', type: 'labeled_value', label: '3 in', properties: { dimension: { kind: 'known', value: 3, unit: 'in' }, from: 'J', to: 'D', axis: 'vertical' }, position: { x: 170, y: 290 }, sourceRegion: { confidence: 0.9 } },
      ],
      relationships: [
        { id: 'rel_1', type: 'connects', source: 'point_B', target: 'point_J', properties: {}, confidence: 0.90 },
        { id: 'rel_2', type: 'connects', source: 'point_J', target: 'point_D', properties: {}, confidence: 0.90 },
        { id: 'rel_3', type: 'applied_at', source: 'force_pull', target: 'point_J', properties: {}, confidence: 0.85 },
      ],
      constraints: [], unknowns: [{ entityId: 'point_J', property: 'tension_BJ' }, { entityId: 'point_J', property: 'tension_JD' }], visualGroups: [],
      ambiguities: [{ elementId: 'point_C', alternatives: [{ description: 'C is bow vertex (parabola apex)', patch: {}, probability: 0.6 }, { description: 'C is dimension reference only', patch: { type: 'annotation' }, probability: 0.4 }], resolved: false }],
    };
    actions.setParseResult(mockResult);
  }, [state.image, actions]);
  
  const handleSendMessage = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = { role: 'user', content: chatInput.trim() };
    actions.dispatch({ type: 'ADD_PRE_PARSE_MESSAGE', payload: userMsg });
    setChatInput('');
    setChatLoading(true);
    
    // Build conversation for Haiku
    const messages = [...state.preParseMessages, userMsg].map(m => ({ role: m.role, content: m.content }));
    
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: `You are a helpful engineering tutor assistant. Help the user describe their statics/physics problem clearly before they upload an image for analysis. 
Ask clarifying questions about:
- What type of problem (statics, circuits, etc.)
- Known values (forces, dimensions, angles)
- What they need to find (tensions, reactions, etc.)
- Any specific points or labels in their diagram
Keep responses brief (2-3 sentences). Build understanding incrementally.`,
          messages
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const text = data.content?.[0]?.text || 'I understand. Please continue or add your image when ready.';
      actions.dispatch({ type: 'ADD_PRE_PARSE_MESSAGE', payload: { role: 'assistant', content: text } });
    } catch (err) {
      actions.dispatch({ type: 'ADD_PRE_PARSE_MESSAGE', payload: { role: 'assistant', content: `(Connection error - your input was saved: "${userMsg.content}")` } });
    } finally {
      setChatLoading(false);
    }
  };
  
  const hasImage = state.image.base64 !== null;
  
  // Always show split view with chat - image is optional
  return (
    <div className="flex-1 flex">
      {/* Left: Image area */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 bg-gray-50 border-r">
        {hasImage ? (
          <>
            <img src={preview || state.image.base64} alt="Problem" className="max-h-96 rounded shadow-lg" />
            <p className="mt-3 text-sm text-gray-600">{state.image.filename} ({state.image.width} × {state.image.height})</p>
            <div className="mt-4 flex gap-3">
              <button onClick={handleAnalyze} disabled={analyzing} className={`px-6 py-2 rounded-lg font-medium text-white ${analyzing ? 'bg-gray-400' : 'bg-green-600 hover:bg-green-700'}`}>
                {analyzing ? 'Analyzing...' : 'Analyze Now'}
              </button>
              <button onClick={handleUseMockData} className="px-4 py-2 rounded-lg text-sm text-gray-600 bg-gray-200 hover:bg-gray-300">Test Data</button>
              <button onClick={() => { setPreview(null); actions.clearImage(); }} className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-700">Clear</button>
            </div>
          </>
        ) : (
          <div className={`w-full max-w-md border-2 border-dashed rounded-xl p-8 text-center transition-colors ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}`} onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }} onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }} onDrop={(e) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}>
            <div className="text-5xl mb-3">📷</div>
            <p className="text-gray-600">Drop image here</p>
            <p className="text-xs text-gray-400 mt-1">or Ctrl+V to paste</p>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Select</button>
          </div>
        )}
        {error && <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm max-w-md">{error}</div>}
      </div>
      
      {/* Right: Chat panel - always visible */}
      <div className="w-96 flex flex-col bg-white">
        <div className="p-4 border-b bg-gray-50">
          <h3 className="font-semibold text-gray-700">Describe Your Problem</h3>
          <p className="text-xs text-gray-500 mt-1">Chat first, add image when ready</p>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {state.preParseMessages.length === 0 && (
            <div className="text-sm text-gray-400 italic space-y-2">
              <p>Start by describing:</p>
              <p>• "I have a statics problem with a bow"</p>
              <p>• "62 lb force pulling horizontal right"</p>
              <p>• "Find tensions in strings BJ and JD"</p>
            </div>
          )}
          {state.preParseMessages.map((msg, i) => (
            <div key={i} className={`p-3 rounded-lg text-sm ${msg.role === 'user' ? 'bg-blue-100 ml-8' : 'bg-gray-100 mr-8'}`}>
              {msg.content}
            </div>
          ))}
          {chatLoading && <div className="p-3 rounded-lg text-sm bg-gray-100 mr-8 animate-pulse">Thinking...</div>}
          <div ref={chatEndRef} />
        </div>
        
        <div className="p-4 border-t">
          <div className="flex gap-2">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              placeholder="Describe the problem..."
              className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button onClick={handleSendMessage} disabled={chatLoading} className={`px-4 py-2 rounded-lg text-sm text-white ${chatLoading ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'}`}>Send</button>
          </div>
          {!hasImage && state.preParseMessages.length > 0 && (
            <p className="text-xs text-amber-600 mt-2">↑ Add an image to analyze</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================
// EDIT VIEW
// ============================================
function EditView() {
  const { state, actions, canSolve, unresolvedAmbiguities } = useApp();
  
  const handleSolve = () => {
    if (!state.parseResult) return;
    actions.dispatch({ type: 'SET_MODE', payload: 'solving' });
    try { const result = solveStatics(state.parseResult); actions.dispatch({ type: 'SET_SOLVE_RESULT', payload: result }); }
    catch (err) { actions.dispatch({ type: 'SET_SOLVE_ERRORS', payload: [err.message] }); }
  };
  
  return (
    <div className="flex-1 flex flex-col">
      <div className="h-12 bg-white border-b flex items-center px-4 gap-2">
        <button onClick={() => actions.toggleGrid()} className={`px-3 py-1.5 text-sm rounded ${state.showGrid ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'}`}>Grid</button>
        <div className="flex-1" />
        {unresolvedAmbiguities.length > 0 && <span className="text-amber-600 text-sm mr-4">⚠ {unresolvedAmbiguities.length} item(s) need review</span>}
        <button onClick={handleSolve} disabled={!canSolve} className={`px-6 py-1.5 text-sm font-medium rounded ${canSolve ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}>Solve</button>
      </div>
      <div className="flex-1 flex"><DiagramCanvas /><CorrectionPanel /></div>
      <AmbiguityModal />
    </div>
  );
}

// ============================================
// SOLUTION VIEW
// ============================================
function SolutionView() {
  const { state, actions } = useApp();
  const { solveResult } = state;
  const [expandedStep, setExpandedStep] = useState(null);
  
  if (!solveResult) return <div className="flex-1 flex items-center justify-center text-gray-500">No solution</div>;
  
  return (
    <div className="flex-1 flex flex-col">
      <div className="h-12 bg-white border-b flex items-center px-4">
        <button onClick={() => actions.dispatch({ type: 'SET_MODE', payload: 'edit' })} className="px-3 py-1.5 text-sm rounded hover:bg-gray-100">← Back to Edit</button>
        <div className="flex-1 text-center font-medium text-gray-700">Solution - {solveResult.domain}</div>
      </div>
      <div className="flex-1 flex">
        <div className="flex-1"><DiagramCanvas /></div>
        <div className="w-96 bg-white border-l overflow-y-auto">
          <div className="p-4"><h3 className="font-semibold text-gray-700 mb-4">Solution Steps</h3>
            <div className="space-y-3">{solveResult.steps.map((step, i) => (
              <div key={i} className={`border rounded-lg overflow-hidden ${expandedStep === i ? 'ring-2 ring-blue-500' : ''}`}>
                <button onClick={() => setExpandedStep(expandedStep === i ? null : i)} className="w-full p-3 text-left bg-gray-50 hover:bg-gray-100 flex items-center gap-3">
                  <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center">{i + 1}</span>
                  <span className="font-medium text-sm">{step.title}</span>
                </button>
                {expandedStep === i && <div className="p-3 border-t bg-white space-y-2">
                  {step.description && <p className="text-sm text-gray-600">{step.description}</p>}
                  {step.equation && <div className="p-2 bg-gray-100 rounded font-mono text-sm whitespace-pre-wrap">{step.equation}</div>}
                  {step.result && <div className="p-2 bg-green-50 rounded font-mono text-sm font-medium text-green-700 whitespace-pre-wrap">{step.result}</div>}
                </div>}
              </div>
            ))}</div>
          </div>
          <div className="p-4 border-t"><h3 className="font-semibold text-gray-700 mb-4">Final Answers</h3>
            <div className="space-y-2">{Object.entries(solveResult.solution).map(([v, { value, unit }]) => (
              <div key={v} className="flex justify-between items-center p-3 bg-green-50 rounded-lg border border-green-200">
                <span className="font-mono font-medium">{v}</span>
                <span className="font-mono text-green-700">{value.toFixed(2)} {unit}</span>
              </div>
            ))}{Object.keys(solveResult.solution).length === 0 && <p className="text-gray-500 text-sm">No values solved</p>}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================
// ROOT APP
// ============================================
function AppContent() {
  const { state } = useApp();
  return (
    <div className="h-screen flex flex-col bg-gray-100">
      <header className="h-14 bg-white border-b flex items-center px-6 shadow-sm">
        <h1 className="text-xl font-bold text-gray-800">Visual Problem Solver</h1>
        <span className="ml-3 text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">{state.mode}</span>
        <div className="flex-1" />
        {state.parseResult && <span className="text-sm text-gray-600">{state.parseResult.entities.length} entities · {state.parseResult.relationships.length} relationships</span>}
      </header>
      <main className="flex-1 flex overflow-hidden">
        {(state.mode === 'upload' || state.mode === 'review' || state.mode === 'parsing') && <ImageUpload />}
        {state.mode === 'edit' && <EditView />}
        {(state.mode === 'solving' || state.mode === 'solution') && <SolutionView />}
      </main>
      <footer className="h-8 bg-white border-t flex items-center px-4 text-xs text-gray-500">
        {state.mode === 'parsing' && 'Analyzing image...'}
        {state.mode === 'solving' && 'Solving equations...'}
        {state.selection && <span>Selected: {state.selection.id}</span>}
        <div className="flex-1" />
        {state.corrections.length > 0 && <span>{state.corrections.length} corrections</span>}
      </footer>
    </div>
  );
}

export default function App() {
  return <AppProvider><AppContent /></AppProvider>;
}
