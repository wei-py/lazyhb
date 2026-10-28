#!/usr/bin/env bun
try {
  const { main } = await import("../dist/index.js");
  await main();
} catch (error) {
  console.error(
    "lazyhb: " + (error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
}
