import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '10mb' }));

// Initialize GoogleGenAI server-side client
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Please configure it in Settings > Secrets panel.');
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

const SYSTEM_INSTRUCTION = `You are PC CHAT, a world-class professional AI assistant built for high-performance productivity, coding, writing, problem-solving, and conversational intelligence.

Key Guidelines:
1. Languages: You fully support both English and Hindi (both Devanagari script and conversational Hinglish).
   - If the user communicates in Hindi (e.g. "नमस्ते", "मुझे एक ईमेल लिख कर दो") or Hinglish (e.g. "kese ho bhai", "mujhe react explain karo"), reply naturally and respectfully in Hindi or Hinglish.
   - If the user communicates in English, respond in polished, clear English.
   - You can also explain concepts bilingually or translate when requested.
2. Tone & Personality: You are PC CHAT — helpful, articulate, professional, polite, and confident.
3. Formatting: Provide structured, easy-to-read answers using Markdown (bold highlights, clear section headings, bullet points, clean numbered lists).
4. Code & Technical Tasks: When asked for code, produce clean, modern, well-commented code with correct language tags for code blocks.
5. Accuracy: Be direct and give high-utility answers without unnecessary fluff.`;

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  const key = process.env.GEMINI_API_KEY;
  const hasKey = Boolean(key && key.trim().length > 0 && key !== 'MY_GEMINI_API_KEY');
  res.json({ status: 'ok', name: 'PC CHAT API', configured: hasKey, keyLength: key ? key.length : 0 });
});


const CANDIDATE_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];

// Format and sanitize messages for Gemini contents format (multimodal support)
function prepareContents(messages: Array<any>) {
  const contents: any[] = [];

  for (const msg of messages) {
    if (!msg) continue;
    const parts: any[] = [];

    // Feature 2: Image Understanding - include inlineData if user attached an image
    if (msg.imageAttachment) {
      let mimeType = msg.imageAttachment.mimeType || 'image/jpeg';
      let base64Data = '';
      if (typeof msg.imageAttachment.dataUrl === 'string') {
        const match = msg.imageAttachment.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          base64Data = match[2];
        } else {
          base64Data = msg.imageAttachment.dataUrl;
        }
      } else if (typeof msg.imageAttachment.base64 === 'string') {
        base64Data = msg.imageAttachment.base64;
      }
      if (base64Data) {
        parts.push({
          inlineData: {
            mimeType,
            data: base64Data,
          },
        });
      }
    }

    if (msg.content && typeof msg.content === 'string' && msg.content.trim().length > 0) {
      parts.push({ text: msg.content.trim() });
    } else if (parts.length > 0) {
      // Default prompt if user only provided image
      parts.push({
        text: 'Please describe and analyze this image in detail. Read any text visible, identify objects, and explain the context.',
      });
    }

    if (parts.length > 0) {
      contents.push({
        role: msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user',
        parts,
      });
    }
  }

  if (contents.length === 0) {
    throw new Error('At least one non-empty message or image is required');
  }

  return contents;
}

// Feature 1: Real AI Image Generator endpoint
app.post('/api/generate-image', async (req: Request, res: Response) => {
  try {
    const { prompt, aspectRatio = '1:1' } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Please enter a prompt describing the image to generate.' });
    }

    let ai;
    try {
      ai = getGeminiClient();
    } catch (keyErr: any) {
      return res.status(400).json({ error: keyErr.message });
    }

    // Supported Google image generation models from SKILL.md
    const imageModels = ['gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1'];
    let lastErr: any = null;

    for (const model of imageModels) {
      try {
        console.log(`Generating image with model: ${model}`);
        const response = await ai.models.generateContent({
          model,
          contents: {
            parts: [{ text: prompt.trim() }],
          },
          config: {
            imageConfig: {
              aspectRatio,
            },
          },
        });

        // Search for inlineData image part
        for (const part of response.candidates?.[0]?.content?.parts ?? []) {
          if (part.inlineData?.data) {
            const mime = part.inlineData.mimeType || 'image/png';
            const imageUrl = `data:${mime};base64,${part.inlineData.data}`;
            return res.json({ imageUrl, prompt: prompt.trim(), model, aspectRatio });
          }
        }
      } catch (err: any) {
        console.warn(`Image model ${model} error:`, err?.message || err);
        lastErr = err;
        continue;
      }
    }

    // Try generateImages API on SDK
    try {
      const response = await (ai.models as any).generateImages({
        model: 'imagen-3.0-generate-002',
        prompt: prompt.trim(),
        config: {
          numberOfImages: 1,
          outputMimeType: 'image/png',
          aspectRatio,
        },
      });

      const firstImage = response?.generatedImages?.[0]?.image;
      if (firstImage?.imageBytes) {
        const imageUrl = `data:image/png;base64,${firstImage.imageBytes}`;
        return res.json({ imageUrl, prompt: prompt.trim(), model: 'imagen-3.0-generate-002', aspectRatio });
      }
    } catch (imagenErr: any) {
      console.warn('Imagen model error:', imagenErr?.message || imagenErr);
      if (!lastErr) lastErr = imagenErr;
    }

    // Explain clearly how to enable if unavailable
    const rawError = lastErr?.message || '';
    let userFriendlyMsg = 'Google Image Generation is currently unavailable with the current API key.';
    if (rawError.includes('PERMISSION_DENIED') || rawError.includes('403') || rawError.includes('RESOURCE_EXHAUSTED')) {
      userFriendlyMsg = 'Google Image Generation requires an API key with billing enabled. Please select your billing-enabled key in the Settings > Secrets panel.';
    } else if (rawError.includes('NOT_FOUND') || rawError.includes('404')) {
      userFriendlyMsg = 'Image generation models are not enabled for this project. Please configure a billing-enabled key in Settings > Secrets.';
    }

    return res.status(503).json({
      error: userFriendlyMsg,
      details: rawError,
      requiresSetup: true,
    });
  } catch (error: any) {
    console.error('Error in /api/generate-image:', error);
    return res.status(500).json({ error: error?.message || 'Failed to generate image' });
  }
});

// Non-streaming chat endpoint with model fallback
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { messages, customSystemInstruction } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Valid messages array is required' });
    }

    const ai = getGeminiClient();
    const contents = prepareContents(messages);
    const systemInstruction = customSystemInstruction || SYSTEM_INSTRUCTION;

    let lastError: any = null;

    // Try candidate models in order (handles 503 high demand or temporary outages)
    for (const model of CANDIDATE_MODELS) {
      try {
        console.log(`Calling Gemini with model: ${model}`);
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
          },
        });

        const reply = response.text || '';
        if (reply.trim().length > 0) {
          return res.json({ reply, modelUsed: model });
        }
      } catch (err: any) {
        console.warn(`Model ${model} failed:`, err?.message || err);
        lastError = err;
        // If it's a 503 or 429 or 404, fall through to next candidate model
        continue;
      }
    }

    // If all models failed, return clean error message
    const rawError = lastError?.message || 'Gemini API is temporarily unavailable.';
    let cleanMessage = rawError;
    try {
      const parsed = JSON.parse(rawError);
      if (parsed?.error?.message) {
        cleanMessage = parsed.error.message;
      }
    } catch {}

    return res.status(503).json({ error: cleanMessage });
  } catch (error: any) {
    console.error('Error in /api/chat:', error);
    const errorMessage = error?.message || 'Failed to generate response from Gemini API';
    return res.status(500).json({ error: errorMessage });
  }
});

// Real-time streaming chat endpoint using Server-Sent Events (SSE) with fallback
app.post('/api/chat/stream', async (req: Request, res: Response) => {
  try {
    const { messages, customSystemInstruction } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Valid messages array is required' });
    }

    let ai;
    try {
      ai = getGeminiClient();
    } catch (keyErr: any) {
      return res.status(400).json({ error: keyErr.message });
    }

    const contents = prepareContents(messages);
    const systemInstruction = customSystemInstruction || SYSTEM_INSTRUCTION;

    let responseStream: any = null;
    let selectedModel = '';
    let lastError: any = null;

    // Try candidate models in order to find one that can stream
    for (const model of CANDIDATE_MODELS) {
      try {
        console.log(`Attempting stream with model: ${model}`);
        responseStream = await ai.models.generateContentStream({
          model,
          contents,
          config: {
            systemInstruction,
          },
        });
        selectedModel = model;
        break; // Stream successfully initiated
      } catch (err: any) {
        console.warn(`Streaming failed with model ${model}:`, err?.message || err);
        lastError = err;
        continue;
      }
    }

    if (!responseStream) {
      const rawError = lastError?.message || 'Gemini streaming service is temporarily unavailable.';
      let cleanMessage = rawError;
      try {
        const parsed = JSON.parse(rawError);
        if (parsed?.error?.message) cleanMessage = parsed.error.message;
      } catch {}
      return res.status(503).json({ error: cleanMessage });
    }

    // Set up SSE headers now that stream connection is established
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    for await (const chunk of responseStream) {
      const text = chunk.text || '';
      if (text) {
        res.write(`data: ${JSON.stringify({ text, model: selectedModel })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('Error in /api/chat/stream:', error);
    const errorMessage = error?.message || 'Streaming error from Gemini API';
    if (!res.headersSent) {
      res.status(500).json({ error: errorMessage });
    } else {
      res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
      res.end();
    }
  }
});

async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PC CHAT Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start PC CHAT server:', err);
});
