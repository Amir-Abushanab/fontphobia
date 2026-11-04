import fontphobia from 'fontphobia/react-router';

export default { ssr: false, prerender: ['/'], buildEnd: fontphobia() };
