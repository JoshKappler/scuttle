// Pure collision-energy math for the destruction model.
export const KAPPA = 0.015; // fraction of collision KE that becomes destruction (tuned in Task 10)
export function reducedMass(mA: number, mB: number): number { return (mA * mB) / (mA + mB || 1); }
export function impactEnergy(mA: number, mB: number, vRelNormal: number, kappa: number): number {
  return kappa * 0.5 * reducedMass(mA, mB) * vRelNormal * vRelNormal;
}
