const pkg = require('./package.json');

module.exports = {
  ...pkg.build,
  directories: { ...(pkg.build.directories || {}), output: 'dist_electron/suite' },
  extraResources: [
    ...(pkg.build.extraResources || []),
    { from: 'build-artifacts/hcanvas-setup.exe', to: 'hcanvas-setup.exe' },
  ],
  nsis: {
    ...(pkg.build.nsis || {}),
    include: 'build/nsis/hcanvas-option.nsh',
    warningsAsErrors: false,
  },
};
