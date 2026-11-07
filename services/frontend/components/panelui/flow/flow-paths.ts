export type FlowSide = 'top' | 'right' | 'bottom' | 'left';

/** A node's box in graph coordinates. */
export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowPoint {
  x: number;
  y: number;
}

/** The outward unit normal of a face — which way an edge sets off. */
export function sideNormal(side: FlowSide): FlowPoint {
  if (side === 'left') return { x: -1, y: 0 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'top') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

/**
 * Where on a face an edge attaches. `offset` runs 0–1 along the face, so two
 * handles on the same side can sit apart without either knowing about the other.
 */
export function anchorOf(rect: FlowRect, side: FlowSide, offset: number): FlowPoint {
  if (side === 'top') {
    return { x: rect.x + rect.width * offset, y: rect.y };
  }
  if (side === 'bottom') {
    return { x: rect.x + rect.width * offset, y: rect.y + rect.height };
  }
  if (side === 'left') {
    return { x: rect.x, y: rect.y + rect.height * offset };
  }
  return { x: rect.x + rect.width, y: rect.y + rect.height * offset };
}

/**
 * Pushes an anchor out along its own face's normal.
 *
 * For an end attached to something that draws its own border: landing exactly
 * on the border puts the line under the stroke, where it reads as stopping
 * short rather than as arriving.
 */
export function standOff(point: FlowPoint, side: FlowSide, by: number): FlowPoint {
  if (by === 0) return point;
  const normal = sideNormal(side);
  return { x: point.x + normal.x * by, y: point.y + normal.y * by };
}

/**
 * The faces two nodes should use when nobody has said. Whichever axis they are
 * further apart on wins, so nodes side by side connect left-to-right and nodes
 * stacked connect top-to-bottom — and the edge changes its mind as they are
 * dragged past each other, which is what makes a hand-arranged graph stay
 * readable without anyone re-specifying anything.
 */
export function autoSides(from: FlowRect, to: FlowRect): { from: FlowSide; to: FlowSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);

  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  }
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

/** A line, for a graph where the routing is not the point. */
export function straightPath(from: FlowPoint, to: FlowPoint): string {
  return `M${from.x},${from.y} L${to.x},${to.y}`;
}

/**
 * How far a bezier's control point sits from its anchor.
 *
 * With room between the two faces it is half the gap, which gives the familiar
 * S. When they overlap — the target is *behind* the source — the gap is
 * negative and half of it would fold the curve inside out, so the offset grows
 * with the square root of the overlap instead: enough to bulge the curve clear
 * of the node, never enough to run away as the overlap grows.
 */
function controlOffset(distance: number, curvature: number): number {
  if (distance >= 0) return 0.5 * distance;
  return curvature * 25 * Math.sqrt(-distance);
}

function controlPoint(
  point: FlowPoint,
  side: FlowSide,
  other: FlowPoint,
  curvature: number
): FlowPoint {
  if (side === 'left') {
    return { x: point.x - controlOffset(point.x - other.x, curvature), y: point.y };
  }
  if (side === 'right') {
    return { x: point.x + controlOffset(other.x - point.x, curvature), y: point.y };
  }
  if (side === 'top') {
    return { x: point.x, y: point.y - controlOffset(point.y - other.y, curvature) };
  }
  return { x: point.x, y: point.y + controlOffset(other.y - point.y, curvature) };
}

/** A cubic curve leaving and arriving perpendicular to each face. */
export function bezierPath(
  from: FlowPoint,
  fromSide: FlowSide,
  to: FlowPoint,
  toSide: FlowSide,
  curvature: number
): string {
  const c1 = controlPoint(from, fromSide, to, curvature);
  const c2 = controlPoint(to, toSide, from, curvature);
  return `M${from.x},${from.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`;
}

function distanceBetween(a: FlowPoint, b: FlowPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * One corner of a stepped path, rounded.
 *
 * The radius is capped at half of the shorter of the two segments meeting here,
 * so a corner between two short runs tucks in rather than overshooting into the
 * segment beyond it and drawing a path that doubles back.
 */
function bend(a: FlowPoint, b: FlowPoint, c: FlowPoint, radius: number): string {
  const size = Math.min(distanceBetween(a, b) / 2, distanceBetween(b, c) / 2, radius);

  // Three collinear points are not a corner.
  if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
    return `L${b.x},${b.y}`;
  }

  if (a.y === b.y) {
    const xDir = a.x < c.x ? -1 : 1;
    const yDir = a.y < c.y ? 1 : -1;
    return `L${b.x + size * xDir},${b.y}Q${b.x},${b.y} ${b.x},${b.y + size * yDir}`;
  }

  const xDir = a.x < c.x ? 1 : -1;
  const yDir = a.y < c.y ? -1 : 1;
  return `L${b.x},${b.y + size * yDir}Q${b.x},${b.y} ${b.x + size * xDir},${b.y}`;
}

/**
 * An orthogonal route with rounded corners — the one that reads as wiring.
 *
 * Both ends first step `gap` points straight out along their own face, so the
 * edge leaves the node square-on instead of grazing its corner. From there the
 * two are joined by a single dog-leg, split across the axis they are further
 * apart on.
 *
 * `radius` of 0 gives hard corners, which is the stepped variant.
 */
export function smoothStepPath(
  from: FlowPoint,
  fromSide: FlowSide,
  to: FlowPoint,
  toSide: FlowSide,
  radius: number,
  gap: number
): string {
  const fromNormal = sideNormal(fromSide);
  const toNormal = sideNormal(toSide);

  let fromGap = {
    x: from.x + fromNormal.x * gap,
    y: from.y + fromNormal.y * gap,
  };
  let toGap = { x: to.x + toNormal.x * gap, y: to.y + toNormal.y * gap };

  // The axis the two gap points are further apart on is the one the dog-leg
  // travels along.
  const horizontal = Math.abs(toGap.x - fromGap.x) > Math.abs(toGap.y - fromGap.y);
  const facing =
    (fromNormal.x !== 0 && toNormal.x !== 0 && fromNormal.x !== toNormal.x) ||
    (fromNormal.y !== 0 && toNormal.y !== 0 && fromNormal.y !== toNormal.y);

  let middle: FlowPoint[];

  if (facing) {
    // Faces pointing at each other: meet in the middle of the run between them.
    const midX = (fromGap.x + toGap.x) / 2;
    const midY = (fromGap.y + toGap.y) / 2;
    middle =
      fromNormal.x !== 0
        ? [
            { x: midX, y: fromGap.y },
            { x: midX, y: toGap.y },
          ]
        : [
            { x: fromGap.x, y: midY },
            { x: toGap.x, y: midY },
          ];
  } else {
    // Faces pointing the same way, or at right angles: one corner is enough.
    // Which of the two possible corners depends on the travelling axis.
    middle = horizontal ? [{ x: toGap.x, y: fromGap.y }] : [{ x: fromGap.x, y: toGap.y }];

    // Two handles on the same face, closer together than the gap: the gap
    // points sit between the anchors and the route folds back over itself.
    // Push them out far enough to clear.
    if (fromSide === toSide) {
      const axis = fromNormal.x !== 0 ? 'x' : 'y';
      const apart = Math.abs(from[axis] - to[axis]);
      if (apart <= gap) {
        const push = Math.min(gap - 1, gap - apart);
        if (axis === 'x') {
          fromGap = { x: fromGap.x + fromNormal.x * push, y: fromGap.y };
          toGap = { x: toGap.x + toNormal.x * push, y: toGap.y };
          middle = [{ x: Math.max(fromGap.x, toGap.x), y: fromGap.y }];
        } else {
          fromGap = { x: fromGap.x, y: fromGap.y + fromNormal.y * push };
          toGap = { x: toGap.x, y: toGap.y + toNormal.y * push };
          middle = [{ x: fromGap.x, y: Math.max(fromGap.y, toGap.y) }];
        }
      }
    }
  }

  const points: FlowPoint[] = [from, fromGap, ...middle, toGap, to];

  // Drop points that repeat the one before them — a duplicate reads as a
  // zero-length segment and makes the bend either side of it collapse.
  const route: FlowPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!;
    const previous = route[route.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    route.push(point);
  }

  if (route.length < 2) return `M${from.x},${from.y}`;

  let d = `M${route[0]!.x},${route[0]!.y}`;
  for (let i = 1; i < route.length - 1; i += 1) {
    d +=
      radius > 0
        ? bend(route[i - 1]!, route[i]!, route[i + 1]!, radius)
        : `L${route[i]!.x},${route[i]!.y}`;
  }
  const last = route[route.length - 1]!;
  d += `L${last.x},${last.y}`;
  return d;
}

/**
 * The `d` string for an edge between two anchors, in whichever shape was asked
 * for. One entry point, so an edge's path is a single call.
 */
export function edgePath(
  variant: 'bezier' | 'smoothstep' | 'step' | 'straight',
  from: FlowPoint,
  fromSide: FlowSide,
  to: FlowPoint,
  toSide: FlowSide,
  curvature: number,
  radius: number,
  gap: number
): string {
  if (variant === 'straight') return straightPath(from, to);
  if (variant === 'bezier') return bezierPath(from, fromSide, to, toSide, curvature);
  return smoothStepPath(from, fromSide, to, toSide, variant === 'step' ? 0 : radius, gap);
}

/** Length of an edge's bounding diagonal — enough to size a dash cycle by. */
export function edgeSpan(from: FlowPoint, to: FlowPoint): number {
  return distanceBetween(from, to);
}

/**
 * The arrowhead at an edge's target, as its own closed path.
 *
 * SVG has `marker-end` for exactly this, and it is the obvious way to do it.
 * It is not used, because a path carrying a marker reference stops picking up
 * new geometry on re-render — the arrow-bearing edges freeze where they were
 * first drawn while arrow-less ones follow their nodes. Drawing the triangle
 * as an ordinary path costs nine numbers and behaves.
 *
 * `dirX`/`dirY` is the unit direction of travel *into* the target.
 */
export function arrowHeadPath(
  tip: FlowPoint,
  dirX: number,
  dirY: number,
  size: number
): string {
  const length = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
  const ux = dirX / length;
  const uy = dirY / length;
  // The perpendicular, for the two back corners.
  const px = -uy;
  const py = ux;

  const baseX = tip.x - ux * size;
  const baseY = tip.y - uy * size;
  const half = size * 0.45;

  return (
    `M${tip.x},${tip.y} ` +
    `L${baseX + px * half},${baseY + py * half} ` +
    `L${baseX - px * half},${baseY - py * half} Z`
  );
}

/**
 * Which way an edge is travelling as it arrives. Every routing but `straight`
 * comes in perpendicular to the target's face, so the face decides it; a
 * straight line comes in along itself.
 */
export function arrivalDirection(
  variant: 'bezier' | 'smoothstep' | 'step' | 'straight',
  from: FlowPoint,
  to: FlowPoint,
  toSide: FlowSide
): { x: number; y: number } {
  if (variant === 'straight') {
    return { x: to.x - from.x, y: to.y - from.y };
  }
  const normal = sideNormal(toSide);
  // The face points outward; the edge arrives against it.
  return { x: -normal.x, y: -normal.y };
}
