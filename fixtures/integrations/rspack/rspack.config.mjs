import { rspack } from '@rspack/core';
import FontphobiaPlugin from 'fontphobia/rspack';

export default {
  mode: 'production',
  entry: './src/index.js',
  experiments: { css: true },
  module: { rules: [{ test: /\.css$/, type: 'css' }, { test: /\.woff2$/, type: 'asset' }] },
  plugins: [new rspack.HtmlRspackPlugin(), new FontphobiaPlugin()],
};
