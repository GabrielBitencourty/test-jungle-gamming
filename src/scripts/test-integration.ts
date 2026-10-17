async function runIntegrationTests(): Promise<void> {
  const child = Bun.spawn([process.execPath, 'test', 'src/integration'], {
    env: { ...process.env, RUN_INTEGRATION: 'true' },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exitCode = await child.exited;
}

void runIntegrationTests().catch((error: unknown) => {
  console.error('Could not run integration tests', error);
  process.exitCode = 1;
});
