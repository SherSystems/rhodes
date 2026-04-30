import { describe, it, expect } from "vitest";

import {
  CloudInitGenerator,
  KickstartGenerator,
  UnattendGeneratorDispatcher,
  WindowsAutounattendGenerator,
} from "../../src/provisioning/unattend-generator.js";

describe("Unattend generators (scaffold)", () => {
  describe("WindowsAutounattendGenerator", () => {
    const gen = new WindowsAutounattendGenerator();

    it("supports Windows targets", () => {
      expect(gen.supports).toContain("windows-11");
      expect(gen.supports).toContain("windows-server-2022");
    });

    it("throws a TODO for windows-11", async () => {
      await expect(gen.generate("windows-11")).rejects.toThrow(
        /TODO: implement Windows autounattend.xml generation for windows-11/,
      );
    });

    it("rejects unsupported targets", async () => {
      await expect(gen.generate("ubuntu-24.04")).rejects.toThrow(
        /does not support ubuntu-24.04/,
      );
    });
  });

  describe("CloudInitGenerator", () => {
    const gen = new CloudInitGenerator();

    it("supports Ubuntu / Debian / Fedora cloud images", () => {
      expect(gen.supports).toContain("ubuntu-24.04");
      expect(gen.supports).toContain("debian-12");
      expect(gen.supports).toContain("fedora-40");
    });

    it("throws a TODO for ubuntu-24.04", async () => {
      await expect(gen.generate("ubuntu-24.04")).rejects.toThrow(
        /TODO: implement cloud-init user-data generation for ubuntu-24.04/,
      );
    });

    it("rejects Windows targets", async () => {
      await expect(gen.generate("windows-11")).rejects.toThrow(
        /does not support windows-11/,
      );
    });
  });

  describe("KickstartGenerator", () => {
    const gen = new KickstartGenerator();

    it("supports rocky-9", () => {
      expect(gen.supports).toContain("rocky-9");
    });

    it("throws a TODO for rocky-9", async () => {
      await expect(gen.generate("rocky-9")).rejects.toThrow(
        /TODO: implement kickstart generation for rocky-9/,
      );
    });
  });
});

describe("UnattendGeneratorDispatcher", () => {
  const dispatcher = new UnattendGeneratorDispatcher();

  it("picks WindowsAutounattendGenerator for windows-11", () => {
    expect(dispatcher.pick("windows-11")).toBeInstanceOf(WindowsAutounattendGenerator);
  });

  it("picks WindowsAutounattendGenerator for windows-server-2022", () => {
    expect(dispatcher.pick("windows-server-2022")).toBeInstanceOf(WindowsAutounattendGenerator);
  });

  it("picks CloudInitGenerator for ubuntu-22.04", () => {
    expect(dispatcher.pick("ubuntu-22.04")).toBeInstanceOf(CloudInitGenerator);
  });

  it("picks CloudInitGenerator for debian-12", () => {
    expect(dispatcher.pick("debian-12")).toBeInstanceOf(CloudInitGenerator);
  });

  it("picks CloudInitGenerator for fedora-40", () => {
    expect(dispatcher.pick("fedora-40")).toBeInstanceOf(CloudInitGenerator);
  });

  it("picks KickstartGenerator for rocky-9", () => {
    expect(dispatcher.pick("rocky-9")).toBeInstanceOf(KickstartGenerator);
  });

  it("propagates the generator's TODO error from generate()", async () => {
    await expect(dispatcher.generate("windows-11")).rejects.toThrow(/TODO: implement/);
  });
});
