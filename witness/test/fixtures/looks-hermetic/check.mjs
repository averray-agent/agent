try {
  const response = await fetch("https://example.com/");
  process.exit(response.ok ? 0 : 1);
} catch (error) {
  console.error(`LOOKED_HERMETIC_BUT_FETCH_FAILED: ${error.message}`);
  process.exit(1);
}
