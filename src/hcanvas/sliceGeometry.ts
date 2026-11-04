/**
 * Pure polygon slicing geometry for the hcanvas line-cut feature.
 *
 * Polygons arrive in block-local pixel coordinates and may be wound in either
 * direction. A cut always uses the infinite line through the drawn segment, but
 * the drawn segment itself must touch the polygon boundary or lie inside it;
 * otherwise the cut is rejected so dragging a line beside a block does nothing.
 */

export interface SlicePoint {
  x: number;
  y: number;
}

/** Two points closer than this are the same vertex (intersections are rounded to 3 decimals). */
const POINT_EPSILON = 1e-6;

/** Slack for deciding which side of the cutting line a vertex is on. */
const SIDE_EPSILON = 1e-9;

/** A split is only useful when both halves are real polygons. */
const MIN_AREA = 0.001;

const DECIMAL_PLACES = 3;
const ROUND_FACTOR = 10 ** DECIMAL_PLACES;

/** Absolute area of a closed polygon (twice the shoelace sum, halved). */
export function polygonArea(points: SlicePoint[]): number {
  if (!Array.isArray(points) || points.length < 3) return 0;

  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

/**
 * Cuts a polygon with the infinite line through lineStart/lineEnd.
 *
 * Returns two closed rings (first point is not repeated at the end), or null
 * when the drawn segment misses the polygon, the vertices all sit on one side,
 * or either half is degenerate.
 */
export function splitPolygon(
  points: SlicePoint[],
  lineStart: SlicePoint,
  lineEnd: SlicePoint,
): { a: SlicePoint[]; b: SlicePoint[] } | null {
  const ring = cleanRing(points);
  if (ring.length < 3) return null;
  if (!isFinitePoint(lineStart) || !isFinitePoint(lineEnd)) return null;

  const directionX = lineEnd.x - lineStart.x;
  const directionY = lineEnd.y - lineStart.y;
  if (Math.hypot(directionX, directionY) <= POINT_EPSILON) return null;

  const sideOf = (point: SlicePoint): number =>
    directionX * (point.y - lineStart.y) - directionY * (point.x - lineStart.x);

  let hasPositive = false;
  let hasNegative = false;
  for (const point of ring) {
    const distance = sideOf(point);
    if (distance > SIDE_EPSILON) hasPositive = true;
    else if (distance < -SIDE_EPSILON) hasNegative = true;
  }
  // Every vertex is on the line or on the same side: nothing to separate.
  if (!hasPositive || !hasNegative) return null;

  // The infinite line may cross, but a segment dragged entirely outside must not cut.
  if (!segmentTouchesPolygon(ring, lineStart, lineEnd)) return null;

  const a = cleanRing(clipHalfPlane(ring, sideOf, 1));
  const b = cleanRing(clipHalfPlane(ring, sideOf, -1));

  if (a.length < 3 || b.length < 3) return null;
  if (polygonArea(a) <= MIN_AREA || polygonArea(b) <= MIN_AREA) return null;

  return { a, b };
}

function isFinitePoint(point: SlicePoint): boolean {
  return Boolean(point) && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function pointsEqual(left: SlicePoint, right: SlicePoint): boolean {
  return Math.abs(left.x - right.x) <= POINT_EPSILON && Math.abs(left.y - right.y) <= POINT_EPSILON;
}

/** Copies a ring, dropping repeated vertices and a closing point equal to the first. */
function cleanRing(points: SlicePoint[]): SlicePoint[] {
  if (!Array.isArray(points)) return [];

  const ring: SlicePoint[] = [];
  for (const point of points) {
    if (!isFinitePoint(point)) return [];
    const last = ring[ring.length - 1];
    if (last && pointsEqual(last, point)) continue;
    ring.push({ x: point.x, y: point.y });
  }
  while (ring.length > 1 && pointsEqual(ring[0]!, ring[ring.length - 1]!)) ring.pop();
  return ring;
}

function roundCoordinate(value: number): number {
  const rounded = Math.round(value * ROUND_FACTOR) / ROUND_FACTOR;
  return rounded === 0 ? 0 : rounded;
}

function roundPoint(point: SlicePoint): SlicePoint {
  return { x: roundCoordinate(point.x), y: roundCoordinate(point.y) };
}

/** Clips a ring to one side of the cutting line (Sutherland-Hodgman, one half-plane). */
function clipHalfPlane(
  ring: SlicePoint[],
  sideOf: (point: SlicePoint) => number,
  orientation: 1 | -1,
): SlicePoint[] {
  const output: SlicePoint[] = [];

  for (let index = 0; index < ring.length; index += 1) {
    const previous = ring[(index + ring.length - 1) % ring.length]!;
    const current = ring[index]!;
    const previousDistance = orientation * sideOf(previous);
    const currentDistance = orientation * sideOf(current);
    const previousInside = previousDistance >= -SIDE_EPSILON;
    const currentInside = currentDistance >= -SIDE_EPSILON;

    if (currentInside !== previousInside) {
      output.push(roundPoint(lineCrossing(previous, current, previousDistance, currentDistance)));
    }
    if (currentInside) output.push(current);
  }

  return output;
}

/** Point where segment previous-current crosses the cutting line, from signed distances. */
function lineCrossing(
  previous: SlicePoint,
  current: SlicePoint,
  previousDistance: number,
  currentDistance: number,
): SlicePoint {
  const denominator = previousDistance - currentDistance;
  const ratio = Math.abs(denominator) <= SIDE_EPSILON ? 0 : previousDistance / denominator;
  const clamped = Math.min(1, Math.max(0, ratio));
  return {
    x: previous.x + (current.x - previous.x) * clamped,
    y: previous.y + (current.y - previous.y) * clamped,
  };
}

/** True when the drawn segment meets the boundary or sits entirely inside the ring. */
function segmentTouchesPolygon(ring: SlicePoint[], start: SlicePoint, end: SlicePoint): boolean {
  for (let index = 0; index < ring.length; index += 1) {
    const edgeStart = ring[index]!;
    const edgeEnd = ring[(index + 1) % ring.length]!;
    if (segmentsTouch(start, end, edgeStart, edgeEnd)) return true;
  }
  // Without a boundary crossing, the whole segment is inside or outside; its midpoint decides.
  return pointInPolygon({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, ring);
}

function segmentsTouch(
  aStart: SlicePoint,
  aEnd: SlicePoint,
  bStart: SlicePoint,
  bEnd: SlicePoint,
): boolean {
  if (segmentIntersection(aStart, aEnd, bStart, bEnd)) return true;
  // Covers endpoint touches and collinear overlap that the line test treats as parallel.
  return (
    pointOnSegment(aStart, bStart, bEnd) ||
    pointOnSegment(aEnd, bStart, bEnd) ||
    pointOnSegment(bStart, aStart, aEnd) ||
    pointOnSegment(bEnd, aStart, aEnd)
  );
}

/** Intersection of two closed segments, or null when parallel or disjoint. */
function segmentIntersection(
  aStart: SlicePoint,
  aEnd: SlicePoint,
  bStart: SlicePoint,
  bEnd: SlicePoint,
): SlicePoint | null {
  const aX = aEnd.x - aStart.x;
  const aY = aEnd.y - aStart.y;
  const bX = bEnd.x - bStart.x;
  const bY = bEnd.y - bStart.y;
  const denominator = aX * bY - aY * bX;
  if (Math.abs(denominator) <= POINT_EPSILON * POINT_EPSILON) return null;

  const offsetX = bStart.x - aStart.x;
  const offsetY = bStart.y - aStart.y;
  const aRatio = (offsetX * bY - offsetY * bX) / denominator;
  const bRatio = (offsetX * aY - offsetY * aX) / denominator;
  if (aRatio < -POINT_EPSILON || aRatio > 1 + POINT_EPSILON) return null;
  if (bRatio < -POINT_EPSILON || bRatio > 1 + POINT_EPSILON) return null;

  return { x: aStart.x + aRatio * aX, y: aStart.y + aRatio * aY };
}

function pointOnSegment(point: SlicePoint, start: SlicePoint, end: SlicePoint): boolean {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared <= POINT_EPSILON) return pointsEqual(point, start);

  const cross = Math.abs((point.x - start.x) * deltaY - (point.y - start.y) * deltaX);
  if (cross > POINT_EPSILON * Math.sqrt(lengthSquared)) return false;

  const dot = (point.x - start.x) * deltaX + (point.y - start.y) * deltaY;
  return dot >= -POINT_EPSILON && dot <= lengthSquared + POINT_EPSILON;
}

/** Ray-casting point-in-polygon test; boundary handling is covered by the segment checks. */
function pointInPolygon(point: SlicePoint, ring: SlicePoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const current = ring[index]!;
    const prior = ring[previous]!;
    const intersects =
      current.y > point.y !== prior.y > point.y &&
      point.x < ((prior.x - current.x) * (point.y - current.y)) / (prior.y - current.y) + current.x;
    if (intersects) inside = !inside;
  }
  return inside;
}
