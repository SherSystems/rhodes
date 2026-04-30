import { describe, it, expect } from "vitest";

import {
  FedoraMirrorResolver,
  IsoResolverDispatcher,
  UbuntuReleasesResolver,
  WindowsFwlinkResolver,
} from "../../src/provisioning/iso-resolver.js";

describe("ISO resolvers (scaffold)", () => {
  describe("WindowsFwlinkResolver", () => {
    const resolver = new WindowsFwlinkResolver();

    it("declares supported Windows targets", () => {
      expect(resolver.supports).toContain("windows-11");
      expect(resolver.supports).toContain("windows-server-2022");
    });

    it("throws a TODO for windows-11", async () => {
      await expect(resolver.resolve("windows-11")).rejects.toThrow(
        /TODO: implement Windows ISO resolution for windows-11/,
      );
    });

    it("rejects unsupported targets", async () => {
      await expect(resolver.resolve("ubuntu-24.04")).rejects.toThrow(
        /does not support ubuntu-24.04/,
      );
    });
  });

  describe("UbuntuReleasesResolver", () => {
    const resolver = new UbuntuReleasesResolver();

    it("declares supported Debian-family targets", () => {
      expect(resolver.supports).toContain("ubuntu-24.04");
      expect(resolver.supports).toContain("debian-12");
    });

    it("throws a TODO for ubuntu-24.04", async () => {
      await expect(resolver.resolve("ubuntu-24.04")).rejects.toThrow(
        /TODO: implement Ubuntu ISO resolution for ubuntu-24.04/,
      );
    });

    it("rejects Windows targets", async () => {
      await expect(resolver.resolve("windows-11")).rejects.toThrow(
        /does not support windows-11/,
      );
    });
  });

  describe("FedoraMirrorResolver", () => {
    const resolver = new FedoraMirrorResolver();

    it("supports Fedora and Rocky", () => {
      expect(resolver.supports).toContain("fedora-40");
      expect(resolver.supports).toContain("rocky-9");
    });

    it("throws a TODO for fedora-40", async () => {
      await expect(resolver.resolve("fedora-40")).rejects.toThrow(
        /TODO: implement Fedora\/Rocky ISO resolution for fedora-40/,
      );
    });
  });
});

describe("IsoResolverDispatcher", () => {
  const dispatcher = new IsoResolverDispatcher();

  it("picks WindowsFwlinkResolver for windows-11", () => {
    expect(dispatcher.pick("windows-11")).toBeInstanceOf(WindowsFwlinkResolver);
  });

  it("picks WindowsFwlinkResolver for windows-server-2019", () => {
    expect(dispatcher.pick("windows-server-2019")).toBeInstanceOf(WindowsFwlinkResolver);
  });

  it("picks UbuntuReleasesResolver for ubuntu-22.04", () => {
    expect(dispatcher.pick("ubuntu-22.04")).toBeInstanceOf(UbuntuReleasesResolver);
  });

  it("picks UbuntuReleasesResolver for debian-12", () => {
    expect(dispatcher.pick("debian-12")).toBeInstanceOf(UbuntuReleasesResolver);
  });

  it("picks FedoraMirrorResolver for rocky-9", () => {
    expect(dispatcher.pick("rocky-9")).toBeInstanceOf(FedoraMirrorResolver);
  });

  it("picks FedoraMirrorResolver for fedora-40", () => {
    expect(dispatcher.pick("fedora-40")).toBeInstanceOf(FedoraMirrorResolver);
  });

  it("propagates the resolver's TODO error from resolve()", async () => {
    await expect(dispatcher.resolve("windows-11")).rejects.toThrow(/TODO: implement/);
  });
});
