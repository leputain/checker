function normalizedCandidateName(name: string) {
  return name
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('ru-RU');
}

export async function candidateKey(name: string) {
  const bytes = new TextEncoder().encode(normalizedCandidateName(name));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
