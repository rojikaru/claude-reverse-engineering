import { open as fopen, readFile, writeFile } from "node:fs/promises";

export const readJsonArray = async <T>(filePath: string): Promise<T[]> => {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T[];
  } catch {
    return [];
  }
};

export const writeJsonArray = async <T>(
  filePath: string,
  value: T[],
): Promise<void> => {
  await writeFile(filePath, JSON.stringify(value, null, 2));
};

export const appendJsonlRecords = async (
  filePath: string,
  records: string[],
): Promise<void> => {
  const handle = await fopen(filePath, "a");
  try {
    for (const record of records) {
      await handle.write(`${record}\n`);
    }
  } finally {
    await handle.close();
  }
};

export const readJsonlRecords = async <T>(filePath: string): Promise<T[]> => {
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
};
