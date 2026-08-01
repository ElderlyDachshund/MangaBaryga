import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSettings, openDatabase, saveSettingsPatch } from "../src/db.js";
import { createDefaultSettings } from "../src/domain.js";

test("the legacy 120-second offers pause is replaced by the current default once", async () => {
  await withDatabaseFile(async (path) => {
    const legacyDatabase = openDatabase(path);
    saveSettingsPatch(legacyDatabase, { loopPauseMs: 120_000, maxWantedPagesExclusive: 7 });
    legacyDatabase
      .prepare("DELETE FROM settings WHERE key = 'loopPauseMsLegacyDefaultMigratedAt'")
      .run();
    legacyDatabase.close();

    const migratedDatabase = openDatabase(path);
    const settings = loadSettings(migratedDatabase);

    assert.equal(settings.loopPauseMs, createDefaultSettings().loopPauseMs);
    assert.equal(settings.maxWantedPagesExclusive, 7, "остальные настройки не трогаем");

    // A deliberate 120000 set after the migration must survive the next start.
    saveSettingsPatch(migratedDatabase, { loopPauseMs: 120_000 });
    migratedDatabase.close();

    const reopenedDatabase = openDatabase(path);

    assert.equal(loadSettings(reopenedDatabase).loopPauseMs, 120_000);
    reopenedDatabase.close();
  });
});

test("a non-default offers pause is never rewritten by the migration", async () => {
  await withDatabaseFile(async (path) => {
    const legacyDatabase = openDatabase(path);
    saveSettingsPatch(legacyDatabase, { loopPauseMs: 90_000 });
    legacyDatabase
      .prepare("DELETE FROM settings WHERE key = 'loopPauseMsLegacyDefaultMigratedAt'")
      .run();
    legacyDatabase.close();

    const migratedDatabase = openDatabase(path);

    assert.equal(loadSettings(migratedDatabase).loopPauseMs, 90_000);
    migratedDatabase.close();
  });
});

async function withDatabaseFile(callback: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "baryga-manga-settings-"));

  try {
    await callback(join(directory, "test.sqlite"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
