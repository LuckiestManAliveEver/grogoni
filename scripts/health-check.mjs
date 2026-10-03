const endpoint = process.env.GROGONI_HEALTH_URL ?? "http://127.0.0.1:4000/health";

const response = await fetch(endpoint);

if (!response.ok) {
  throw new Error(`Health check failed with HTTP ${response.status}`);
}

const body = await response.json();

if (body.status !== "ok") {
  throw new Error(`Health check failed: ${JSON.stringify(body)}`);
}

console.log(`Health check passed: ${endpoint}`);
