import * as React from 'react';
import '@fontsource-variable/inter';

// Idiomatic global head tags: setHeadComponents in onRenderBody.
export const onRenderBody = ({ setHeadComponents }) => {
  setHeadComponents([
    <link key="gf-preconnect" rel="preconnect" href="https://fonts.googleapis.com" />,
    <link
      key="gf-fraunces"
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400..700&display=swap"
    />,
  ]);
};
