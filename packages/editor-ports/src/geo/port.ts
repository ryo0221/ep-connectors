// EditorPlatform の Host port から写した、公開してよい型。手で直さず
// `npm run editor-ports:sync -- <editor-platform の checkout>` で写し直す。
// 写した元の commit と symbol は upstream.json にある。

// packages/geo-core/src/model.ts

/** M0 experiment: not a stable public or persisted compatibility contract. */
export type Scalar = string | number | boolean | null;
export type Position = [number, number];
export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString' | 'MultiPoint'; coordinates: Position[] }
  | { type: 'Polygon' | 'MultiLineString'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

// packages/geo-core/src/host.ts

/** `[west, south, east, north]` in CRS84. west > east crosses the antimeridian. */
export type GeoBbox = [number, number, number, number];
export interface GeoFeatureSourceInfo {
  /** Opaque Host handle for one collection the current principal may read. */
  handle: string;
  label: string;
  provider: string;
  /** The connection or public deployment the Host reads through, as plain text. */
  account: string;
  /** Source and terms of use as plain text, kept with anything imported from this source. */
  attribution: string;
}
/** One feature as the Host read it. CRS84 longitude/latitude only. */
export interface GeoExternalFeature {
  /** Provider feature id as a string; null when the provider gave none. */
  id: string | null;
  geometry: Geometry | null;
  /** Scalar properties only. Strings are untrusted plain text, never HTML or links to open. */
  properties: Record<string, Scalar>;
}
export type GeoFeatureRejection =
  | 'invalid-feature'
  | 'invalid-geometry'
  | 'unsupported-geometry'
  | 'unsupported-crs';
export interface GeoFeatureRead {
  sourceHandle: string;
  /** Connection generation; a read from an older generation is never shown. */
  generation: string;
  bbox: GeoBbox;
  /** false when a page failed or a Host limit stopped the read. The rest is unknown, not empty. */
  complete: boolean;
  /** Features the provider reported for the query, when it reported one. */
  matched: number | null;
  /** Features the Host left out, with their reason. Never dropped silently. */
  rejected: { index: number; id: string | null; reason: GeoFeatureRejection }[];
  /** Non-scalar property names the Host left out of `properties`. */
  omittedProperties: string[];
  fetchedAt: number;
  features: GeoExternalFeature[];
}
export interface GeoSourceNotice {
  kind: 'changed' | 'revoked';
  sourceHandle?: string;
}
export interface GeoFeatureReadPort {
  listSources(signal: AbortSignal): Promise<GeoFeatureSourceInfo[]>;
  readFeatures(
    request: { sourceHandle: string; bbox: GeoBbox; limit: number },
    signal: AbortSignal,
  ): Promise<GeoFeatureRead>;
  /** Change or revocation signals only; never content or commands. */
  watch?(notify: (notice: GeoSourceNotice) => void): () => void;
}
/** The upper bound the Editor asks for in one read. */
export const geoFeatureReadLimit = 400;
