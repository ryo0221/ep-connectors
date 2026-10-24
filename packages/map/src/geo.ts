import type { JsonObject, JsonValue } from '@ep-connectors/core';

/**
 * 地理データの読取の DTO（段階と分野 2）。座標は CRS84（経度、緯度の順、WGS 84）だけを扱う。
 * EditorPlatform の Geo が扱うのは CRS84 だけであり、他の CRS は黙って変換せず理由付きで拒否する。
 */
export const CRS84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';

/** `[最小経度, 最小緯度, 最大経度, 最大緯度]`。最小経度が最大経度より大きいときは日付変更線をまたぐ。 */
export type Bbox = [number, number, number, number];

export type Position = [number, number] | [number, number, number];

export type GeoGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] }
  | { type: 'GeometryCollection'; geometries: GeoGeometry[] };

/**
 * 読み取った地物。`properties` の文字列は未信頼の plain text であり、HTML として解釈しない。
 * 中の URL を自動で fetch しない（全体設計 5）。
 */
export type GeoFeature = {
  /** Provider の地物 ID を文字列にしたもの。ID のない地物は `null`。 */
  id: string | null;
  geometry: GeoGeometry | null;
  properties: JsonObject;
};

export type FeatureRejectionReason = 'invalid-feature' | 'invalid-geometry' | 'missing-id';

/** 形の合わない地物は捨てずに、理由と位置を返す。 */
export type FeatureRejection = {
  /** そのページの `features` の中での位置。 */
  index: number;
  id: string | null;
  reason: FeatureRejectionReason;
};

export type BboxCheck = { ok: true; bbox: Bbox } | { ok: false };

/**
 * 領域を検査する。経度は -180〜180、緯度は -90〜90 とし、最小緯度は最大緯度以下とする。
 * 最小経度が最大経度より大きい領域は、日付変更線をまたぐものとして受け付ける。
 */
export function checkBbox(value: readonly number[]): BboxCheck {
  if (value.length !== 4 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return { ok: false };
  }
  const [west, south, east, north] = value as Bbox;
  if (!inLongitude(west) || !inLongitude(east)) return { ok: false };
  if (!inLatitude(south) || !inLatitude(north) || south > north) return { ok: false };
  return { ok: true, bbox: [west, south, east, north] };
}

export function sameBbox(a: Bbox, b: Bbox): boolean {
  return a.every((value, index) => value === b[index]);
}

/** 地物の geometry を検査して写す。CRS84 の範囲外の座標を含むものは拒否する。 */
export function parseGeometry(value: unknown): GeoGeometry | null | 'invalid' {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.type !== 'string') return 'invalid';
  const coordinates = value.coordinates;
  switch (value.type) {
    case 'Point': {
      const position = parsePosition(coordinates);
      return position ? { type: 'Point', coordinates: position } : 'invalid';
    }
    case 'MultiPoint': {
      const positions = parsePositions(coordinates, 0);
      return positions ? { type: 'MultiPoint', coordinates: positions } : 'invalid';
    }
    case 'LineString': {
      const positions = parsePositions(coordinates, 2);
      return positions ? { type: 'LineString', coordinates: positions } : 'invalid';
    }
    case 'MultiLineString': {
      const lines = parseList(coordinates, (line) => parsePositions(line, 2));
      return lines ? { type: 'MultiLineString', coordinates: lines } : 'invalid';
    }
    case 'Polygon': {
      const rings = parseRings(coordinates);
      return rings ? { type: 'Polygon', coordinates: rings } : 'invalid';
    }
    case 'MultiPolygon': {
      const polygons = parseList(coordinates, parseRings);
      return polygons ? { type: 'MultiPolygon', coordinates: polygons } : 'invalid';
    }
    case 'GeometryCollection': {
      if (!Array.isArray(value.geometries)) return 'invalid';
      const geometries: GeoGeometry[] = [];
      for (const member of value.geometries) {
        const parsed = parseGeometry(member);
        if (parsed === null || parsed === 'invalid') return 'invalid';
        geometries.push(parsed);
      }
      return { type: 'GeometryCollection', geometries };
    }
    default:
      return 'invalid';
  }
}

/** GeoJSON の Feature を検査して写す。 */
export function parseFeature(
  value: unknown,
):
  | { ok: true; feature: GeoFeature }
  | { ok: false; id: string | null; reason: FeatureRejectionReason } {
  if (!isRecord(value) || value.type !== 'Feature') {
    return { ok: false, id: null, reason: 'invalid-feature' };
  }
  let id: string | null = null;
  // ID は Provider の不透明な識別子として写す。書き換えると別の地物が同じ ID になり得るため、
  // plain text として扱えない文字を含む ID は拒否する。
  if (typeof value.id === 'string') {
    if (plainText(value.id) !== value.id) return { ok: false, id: null, reason: 'invalid-feature' };
    id = value.id;
  } else if (typeof value.id === 'number' && Number.isFinite(value.id)) id = String(value.id);
  else if (value.id !== undefined && value.id !== null) {
    return { ok: false, id: null, reason: 'invalid-feature' };
  }
  const properties = value.properties ?? null;
  if (properties !== null && !isRecord(properties)) {
    return { ok: false, id, reason: 'invalid-feature' };
  }
  const geometry = parseGeometry(value.geometry ?? null);
  if (geometry === 'invalid') return { ok: false, id, reason: 'invalid-geometry' };
  let copied: JsonObject = {};
  try {
    if (properties !== null) copied = plainObject(properties);
  } catch (error) {
    if (error instanceof UnsafeKey) return { ok: false, id, reason: 'invalid-feature' };
    throw error;
  }
  return {
    ok: true,
    feature: { id, geometry, properties: copied },
  };
}

// 制御文字（tab・改行を除く）と、表示の向きを変える文字を除く。
const UNSAFE_TEXT =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/** 外部から読んだ文字列を plain text として扱えるようにする。HTML の解釈や URL の展開はしない。 */
export function plainText(value: string): string {
  return value.replace(UNSAFE_TEXT, '');
}

function plainValue(value: unknown): JsonValue {
  if (typeof value === 'string') return plainText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map(plainValue);
  if (isRecord(value)) return plainObject(value);
  return null;
}

/** Plain text として扱えない文字を含む属性の名前。 */
class UnsafeKey extends Error {}

function plainObject(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, member] of Object.entries(value)) {
    // 名前は書き換えない。書き換えると別の属性と同じ名前になり、値が上書きされ得る（ID と同じ扱い）。
    if (plainText(key) !== key) throw new UnsafeKey();
    // `__proto__` などの名前も data として持つ。代入では prototype の setter が呼ばれる。
    Object.defineProperty(result, key, {
      value: plainValue(member),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function inLongitude(value: number): boolean {
  return value >= -180 && value <= 180;
}

function inLatitude(value: number): boolean {
  return value >= -90 && value <= 90;
}

function parsePosition(value: unknown): Position | null {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) return null;
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [longitude, latitude] = value as number[];
  if (!inLongitude(longitude as number) || !inLatitude(latitude as number)) return null;
  return [...value] as Position;
}

function parsePositions(value: unknown, minimum: number): Position[] | null {
  const positions = parseList(value, parsePosition);
  return positions && positions.length >= minimum ? positions : null;
}

/** 外周と穴の環。各環は四点以上で、始点と終点が一致する。 */
function parseRings(value: unknown): Position[][] | null {
  const rings = parseList(value, (ring) => {
    const positions = parsePositions(ring, 4);
    if (!positions) return null;
    const first = positions[0] as Position;
    const last = positions.at(-1) as Position;
    return first.length === last.length && first.every((n, i) => n === last[i]) ? positions : null;
  });
  return rings && rings.length > 0 ? rings : null;
}

function parseList<T>(value: unknown, parse: (member: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const result: T[] = [];
  for (const member of value) {
    const parsed = parse(member);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
