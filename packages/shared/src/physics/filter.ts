export function collides(aGroup: number, aMask: number, bGroup: number, bMask: number): boolean {
  return (aMask & bGroup) !== 0 && (aGroup & bMask) !== 0;
}
