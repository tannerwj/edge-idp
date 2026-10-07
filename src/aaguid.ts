/**
 * Friendly names for common passkey providers, keyed by AAGUID (from the
 * community passkey-authenticator-aaguids list). Display only — with
 * attestation "none" the AAGUID is self-reported and never used for trust.
 */
const NAMES: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain (Managed)",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "b5397666-4885-aa6b-cebf-e52262a439a2": "Chromium Browser",
  "771b48fd-d3d4-4f74-9232-fc157ab0507a": "Edge on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
  "fdb141b2-5d84-443e-8a35-4698c205a502": "KeePassXC",
  "cb69481e-8ff7-4039-93ec-0a2729a154a8": "YubiKey 5",
  "ee882879-721c-4913-9775-3dfcce97072a": "YubiKey 5",
  "a25342c0-3cdc-4414-8e46-f4807fca511c": "YubiKey 5",
  "fa2b99dc-9e39-4257-8f92-4a30d23c4118": "YubiKey 5 (FIPS)",
};

export function aaguidName(aaguid: string | null | undefined): string | null {
  if (!aaguid || aaguid === "00000000-0000-0000-0000-000000000000") return null;
  return NAMES[aaguid.toLowerCase()] ?? null;
}
