import localFont from 'next/font/local';

// A self-hosted face through next/font/local (§6.3). DejaVu Sans: Bitstream Vera license, no RFN.
export const fixtureSans = localFont({
  src: '../fonts/DejaVuSans.ttf',
  weight: '400',
  style: 'normal',
  variable: '--font-fixture',
});
