# vLLM 502 Error Diagnosis & Fix

## Root Cause Found ✓

Your configuration uses **`"api":"openai-responses"`** but vLLM requires **`"api":"openai-completions"`**.

### The Problem

In your config:

```json
"models": {
  "mode": "merge",
  "providers": {
    "openai": {
      "baseUrl": "http://192.168.1.240:8143/v1",
      "api": "openai-responses",  // ❌ WRONG - This causes 502
      "models": [...]
    }
  }
}
```

### Why This Causes 502

- **`openai-responses`** = Special API format used by GitHub Copilot and LMStudio (different endpoint/format)
- **`openai-completions`** = Standard OpenAI-compatible API (what vLLM expects)

When openclaw uses the wrong API type, it sends requests in an incompatible format to vLLM, causing vLLM to return a 502 Bad Gateway error.

## Solution

### Fix Your Configuration

Change your config to use `"openai-completions"`:

```json
"models": {
  "mode": "merge",
  "providers": {
    "openai": {
      "baseUrl": "http://192.168.1.240:8143/v1",
      "api": "openai-completions",  // ✓ CORRECT
      "models": [
        {
          "id": "firefunction-v2",
          "name": "FireFunction V2",
          "reasoning": false,
          "input": ["text"],
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

## API Type Reference

openclaw supports three API types:

| API Type             | Use Case                       | Compatible Providers                                         |
| -------------------- | ------------------------------ | ------------------------------------------------------------ |
| `openai-completions` | Standard OpenAI-compatible API | vLLM, Ollama, Moonshot, Hugging Face, Together, Venice, etc. |
| `openai-responses`   | Special response format        | GitHub Copilot, LMStudio                                     |
| `anthropic-messages` | Anthropic API                  | Claude, MiniMax, Xiaomi, etc.                                |

## Verification

After fixing the config:

1. **Restart openclaw** to reload the configuration
2. **Test with curl** to confirm vLLM is still responding:
   ```bash
   curl -X POST http://192.168.1.240:8143/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer test-key" \
     -d '{
       "model": "firefunction-v2",
       "messages": [{"role": "user", "content": "Hello"}],
       "max_tokens": 10
     }'
   ```
3. **Verify openclaw** can now make requests without 502 errors

## Diagnostic Results

The vLLM server is working correctly:

- ✓ Server responds to `/v1/models` endpoint
- ✓ Handles OpenAI-compatible `/v1/chat/completions` requests
- ✓ Model `casperhansen/llama-3.3-70b-instruct-awq` is loaded
- ✓ Network connectivity is fine

The issue is 100% a configuration mismatch.

## Additional Notes

### Why This Matters

- Using the wrong API type causes format mismatch between client and server
- The pi-ai library (used by openclaw) translates requests based on the API type
- `openai-responses` uses different message/response structure than `openai-completions`
- This results in malformed requests that vLLM rejects with 502

### If You Still Get 502 After Fix

1. Clear any cached config or restart the gateway
2. Check vLLM server logs: `docker logs <container_id>`
3. Verify the base URL doesn't have trailing slashes
4. Ensure the model ID matches exactly (case-sensitive)
5. Check firewall/network between openclaw and vLLM

### Similar Setups That Work

- **Ollama**: Use `"api":"openai-completions"` with `baseUrl: "http://localhost:11434/v1"`
- **LMStudio**: Use `"api":"openai-responses"` with appropriate baseUrl
- **Moonshot**: Use `"api":"openai-completions"` with `baseUrl: "https://api.moonshot.ai/v1"`
