# pi-gemini-oauth

Gemini OAuth extension for [Pi](https://github.com/earendil-works/pi-coding-agent) using the Gemini Code Assist API.

This extension allows you to use Gemini models via your Google account OAuth instead of a traditional API key. It uses the `cloudcode-pa.googleapis.com` endpoint, which mirrors the behavior of Gemini Code Assist.

## Features

- **OAuth2 with PKCE**: Secure authentication without needing a client secret in the codebase.
- **Thought Signature Support**: Compatible with reasoning models like Gemini 2.0 Flash Thinking, Gemini 2.5, and Gemini 3.0/3.1.
- **Persistent Sessions**: Tokens are stored securely in Pi's auth system.

## Supported Models

- `google/gemini-2.5-flash`
- `google/gemini-2.5-pro`
- `google/gemini-2.5-flash-lite`
- `google/gemini-3-flash-preview`
- `google/gemini-3.1-pro-preview`
- `google/gemini-2.0-flash-thinking-preview`

## Installation

1. Clone this repository into your Pi extensions directory:
   ```bash
   cd ~/.pi/agent/extensions/
   git clone https://github.com/juancruzleone/pi-gemini-auth pi-gemini-oauth
   ```

2. Reload Pi:
   ```bash
   /reload
   ```

## Usage

1. **Login**:
   ```bash
   /login google
   ```
   A browser window will open. Complete the Google OAuth flow.

2. **Select Model**:
   ```bash
   /model google/gemini-2.5-flash
   ```

## Configuration (Optional)

By default, the extension uses a public OAuth Client ID configured for `localhost:8085`. If you want to use your own Google Cloud project:

- Set `GEMINI_OAUTH_CLIENT_ID` in your environment variables.
- Set `GOOGLE_CLOUD_PROJECT` to force a specific project ID.

## Technical Details

- **PKCE**: Uses `S256` code challenge method.
- **Endpoint**: `https://cloudcode-pa.googleapis.com/v1alpha/projects/{project}/locations/global/publishers/google/models/{model}:streamGenerateContent`
- **History Management**: Automatically strips `thinking` blocks from message history and adds `thoughtSignature: "skip_thought_signature_validator"` to tool calls to satisfy Gemini's reasoning API requirements.

## License

MIT
