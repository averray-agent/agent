try {
  const response = await fetch("https://example.com/");
  process.exit(response.ok ? 0 : 1);
} catch (error) {
  console.error(`NETWORK_REQUIRED: ${error.message}`);
  process.exit(1);
}
