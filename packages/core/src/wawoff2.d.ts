declare module 'wawoff2' {
  const m: { compress(b: Uint8Array): Promise<Uint8Array>; decompress(b: Uint8Array): Promise<Uint8Array> };
  export default m;
}
