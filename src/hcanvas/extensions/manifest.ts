/**
 * Public entry point for the v2 extension manifest model. Types live in
 * manifestTypes.ts and the validator implementation in manifestValidate.ts so
 * each file stays inside the repository size gate.
 */
export * from './manifestTypes.js';
export {
  capabilitiesHash,
  checkExtensionManifest,
  engineRangeSatisfies,
  isEngineRangeShape,
  manifestRequiresProcess,
  stableStringify,
  validateExtensionManifest,
} from './manifestValidate.js';
