// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

// localStorage stub: the persistence path is what a page reload exercises.
const store = new Map<string, string>();
const fakeLocalStorage = {
  get length() {
    return store.size;
  },
  key: (index: number) => [...store.keys()][index] ?? null,
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
};

if (!globalThis.crypto?.subtle) {
  throw new Error("Node WebCrypto (crypto.subtle) required to run MLS tests");
}
(globalThis as unknown as { localStorage: typeof fakeLocalStorage }).localStorage = fakeLocalStorage;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MLS session init key persistence", () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it("decrypts a sealed message after a reload (hydrate from localStorage)", async () => {
    const first = await import("@/lib/mls/keypackage");
    const recipient = "https://example.org/users/bob";
    const kp = await first.generateKeyPackage(recipient);
    const objectId = "https://example.org/users/bob/keyPackages/persisted";
    first.storeSessionInitKey(objectId, kp.session());
    await flush();

    expect(store.size).toBe(1);

    // The envelope is sealed by someone else, using the published key package.
    const parsed = first.parseKeyPackageObject({ content: kp.content })!;
    const envelope = await first.sealToKeyPackage("hola tras recargar", parsed, first.encodeSenderContext(objectId));

    // Reload: a fresh module instance with the same localStorage.
    const second = await import("@/lib/mls/keypackage");
    await second.hydrateSessionInitKeys();

    const opened = await second.openEnvelope(envelope);
    expect(opened).not.toBeNull();
    expect(opened!.plaintext).toBe("hola tras recargar");
  });

  it("exports and re-imports the key bundle (moving a session to another browser)", async () => {
    const first = await import("@/lib/mls/keypackage");
    const kp = await first.generateKeyPackage("https://example.org/users/bob");
    const objectId = "https://example.org/users/bob/keyPackages/moved";
    first.storeSessionInitKey(objectId, kp.session());
    const bundle = await first.exportSessionInitKeys();

    const parsed = first.parseKeyPackageObject({ content: kp.content })!;
    const envelope = await first.sealToKeyPackage("movido", parsed, first.encodeSenderContext(objectId));

    // Another browser: empty store and fresh module state, then import.
    store.clear();
    vi.resetModules();
    const second = await import("@/lib/mls/keypackage");
    expect(await second.openEnvelope(envelope)).toBeNull();
    expect(await second.importSessionInitKeys(bundle)).toBe(1);
    const opened = await second.openEnvelope(envelope);
    expect(opened?.plaintext).toBe("movido");
  });
});
