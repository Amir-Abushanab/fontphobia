// Runs next/font/google's own validation and URL builder on option variants.
const d = 'next/dist/compiled/@next/font/dist/google/';
const { validateGoogleFontFunctionCall: validate } = require(d + 'validate-google-font-function-call');
const { getFontAxes } = require(d + 'get-font-axes');
const { getGoogleFontsUrl } = require(d + 'get-google-fonts-url');
const cases = [
  ['Inter', { subsets: ['latin'] }],
  ['Inter', { subsets: ['latin'], weight: 'variable' }],
  ['Inter', { subsets: ['latin'], weight: '400' }],
  ['Inter', { subsets: ['latin'], weight: 400 }],
  ['Inter', { subsets: ['latin'], weight: ['400', '700'] }],
  ['Inter', { subsets: ['latin'], weight: '100 900' }],
  ['Inter', { subsets: ['latin'], weight: '100..900' }],
  ['Inter', { subsets: ['latin'], weight: ['variable', '400'] }],
  ['Inter', { subsets: ['latin'], axes: ['opsz'] }],
  ['Inter', { subsets: ['latin'], axes: ['wght'] }],
  ['Inter', { subsets: ['latin'], weight: '400', axes: ['opsz'] }],
  ['Inter', { weight: '400' }],
  ['Inter', { preload: false }],
  ['Roboto Flex', { subsets: ['latin'], axes: ['wdth', 'opsz'] }],
  ['Roboto Flex', { subsets: ['latin'], weight: '1000' }],
];
for (const [family, opts] of cases) {
  let out;
  try {
    const v = validate(family.replace(/ /g, '_'), opts);
    out = getGoogleFontsUrl(
      v.fontFamily,
      getFontAxes(v.fontFamily, v.weights, v.styles, v.selectedVariableAxes),
      v.display,
    );
  } catch (e) {
    out = 'ERROR: ' + e.message.split('\n')[0];
  }
  console.log(`${family} ${JSON.stringify(opts)}\n  -> ${out}`);
}
