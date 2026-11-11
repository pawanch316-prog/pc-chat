/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatHeader } from './components/ChatHeader';
import { MessageItem } from './components/MessageItem';
import { ChatInput } from './components/ChatInput';
import { EmptyState } from './components/EmptyState';
import { SettingsModal } from './components/SettingsModal';
import { ChatSession, Message, SupportedLanguage, ImageAttachment } from './types/chat';
import { VoiceSettings, DEFAULT_VOICE_SETTINGS, sanitizeTextForSpeech, getBestVoice } from './utils/voiceManager';
import { ArrowDown, Sparkles } from 'lucide-react';

const STORAGE_KEY = 'pc_chat_sessions_v1';
const CURRENT_SESSION_KEY = 'pc_chat_current_session_id';
const LANG_STORAGE_KEY = 'pc_chat_pref_lang';
const VOICE_STORAGE_KEY = 'pc_chat_pref_voice';

export default function App() {
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.error('Failed to load sessions from localStorage', e);
    }
    const initialSession: ChatSession = {
      id: 'session-' + Date.now(),
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'chat',
    };
    return [initialSession];
  });

  const [currentSessionId, setCurrentSessionId] = useState<string>(() => {
    try {
      const savedId = localStorage.getItem(CURRENT_SESSION_KEY);
      if (savedId) return savedId;
    } catch {}
    return '';
  });

  const [selectedLanguage, setSelectedLanguage] = useState<SupportedLanguage>(() => {
    try {
      const savedLang = localStorage.getItem(LANG_STORAGE_KEY) as SupportedLanguage;
      if (savedLang) return savedLang;
    } catch {}
    return 'auto';
  });

  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(() => {
    try {
      const savedVoice = localStorage.getItem(VOICE_STORAGE_KEY);
      if (savedVoice) return JSON.parse(savedVoice);
    } catch {}
    return DEFAULT_VOICE_SETTINGS;
  });

  const [customPersona, setCustomPersona] = useState<string>('default');
  const [currentMode, setCurrentMode] = useState<'chat' | 'image-studio'>('chat');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [currentlySpeakingId, setCurrentlySpeakingId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Sync active session id
  useEffect(() => {
    if (!currentSessionId && sessions.length > 0) {
      setCurrentSessionId(sessions[0].id);
      setCurrentMode(sessions[0].mode || 'chat');
    } else if (sessions.length > 0 && !sessions.some((s) => s.id === currentSessionId)) {
      setCurrentSessionId(sessions[0].id);
      setCurrentMode(sessions[0].mode || 'chat');
    }
  }, [sessions, currentSessionId]);

  // Persist sessions (Feature 3: Chat History)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch (err) {
      console.error('Could not save sessions to localStorage', err);
    }
  }, [sessions]);

  // Persist active session ID
  useEffect(() => {
    if (currentSessionId) {
      localStorage.setItem(CURRENT_SESSION_KEY, currentSessionId);
    }
  }, [currentSessionId]);

  // Persist language mode
  useEffect(() => {
    localStorage.setItem(LANG_STORAGE_KEY, selectedLanguage);
  }, [selectedLanguage]);

  // Persist voice settings
  useEffect(() => {
    localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(voiceSettings));
  }, [voiceSettings]);

  // Current session object
  const currentSession = sessions.find((s) => s.id === currentSessionId) || sessions[0];

  // Sync currentMode with currentSession
  useEffect(() => {
    if (currentSession?.mode) {
      setCurrentMode(currentSession.mode);
    }
  }, [currentSessionId]);

  // Scroll to bottom helper
  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  useEffect(() => {
    scrollToBottom();
  }, [currentSession?.messages.length, streamingMessageId]);

  // Detect scroll position to show/hide scroll to bottom button
  const handleScroll = () => {
    if (!chatContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 150;
    setShowScrollBottom(!isAtBottom);
  };

  // Keyboard shortcut Ctrl+K for New Chat
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Stop any active speech synthesis
  const stopAllSpeech = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setCurrentlySpeakingId(null);
  };

  // Central speech toggle for messages
  const handleToggleSpeak = (messageId: string, content: string) => {
    if (!('speechSynthesis' in window)) return;

    if (currentlySpeakingId === messageId) {
      stopAllSpeech();
      return;
    }

    stopAllSpeech();

    const cleanText = sanitizeTextForSpeech(content);
    if (!cleanText) return;

    const utterance = new SpeechSynthesisUtterance(cleanText);
    const hasHindiChars = /[\u0900-\u097F]/.test(cleanText);
    const targetLang: 'hi-IN' | 'en-IN' = hasHindiChars ? 'hi-IN' : 'en-IN';
    utterance.lang = targetLang;
    utterance.rate = voiceSettings.rate;
    utterance.pitch = voiceSettings.pitch;

    const matchedVoice = getBestVoice(targetLang);
    if (matchedVoice) {
      utterance.voice = matchedVoice;
    }

    utterance.onend = () => setCurrentlySpeakingId(null);
    utterance.onerror = () => setCurrentlySpeakingId(null);

    setCurrentlySpeakingId(messageId);
    window.speechSynthesis.speak(utterance);
  };

  // Create new chat session (Feature 3)
  const handleNewChat = () => {
    if (isLoading) {
      handleStopGeneration();
    }
    stopAllSpeech();
    const newSession: ChatSession = {
      id: 'session-' + Date.now(),
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'chat',
    };

    setSessions((prev) => [newSession, ...prev]);
    setCurrentSessionId(newSession.id);
    setCurrentMode('chat');
  };

  // Open Image Studio (Feature 1)
  const handleOpenImageStudio = () => {
    if (isLoading) {
      handleStopGeneration();
    }
    stopAllSpeech();

    // Check if current session is empty, convert to image studio
    if (currentSession && currentSession.messages.length === 0) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === currentSessionId ? { ...s, mode: 'image-studio', title: 'AI Image Studio' } : s
        )
      );
      setCurrentMode('image-studio');
      return;
    }

    // Otherwise create dedicated Image Studio session
    const imageSession: ChatSession = {
      id: 'session-img-' + Date.now(),
      title: 'AI Image Studio',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'image-studio',
    };

    setSessions((prev) => [imageSession, ...prev]);
    setCurrentSessionId(imageSession.id);
    setCurrentMode('image-studio');
  };

  // Delete session (Feature 3)
  const handleDeleteSession = (id: string) => {
    stopAllSpeech();
    if (sessions.length <= 1) {
      setSessions([
        {
          id: 'session-' + Date.now(),
          title: 'New Chat',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          mode: 'chat',
        },
      ]);
      return;
    }

    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (currentSessionId === id && filtered.length > 0) {
        setCurrentSessionId(filtered[0].id);
        setCurrentMode(filtered[0].mode || 'chat');
      }
      return filtered;
    });
  };

  // Rename session (Feature 3)
  const handleRenameSession = (id: string, newTitle: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title: newTitle, updatedAt: Date.now() } : s))
    );
  };

  // Clear all sessions (Feature 3)
  const handleClearAllSessions = () => {
    if (isLoading) {
      handleStopGeneration();
    }
    stopAllSpeech();
    const freshSession: ChatSession = {
      id: 'session-' + Date.now(),
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'chat',
    };
    setSessions([freshSession]);
    setCurrentSessionId(freshSession.id);
    setCurrentMode('chat');
  };

  // Clear current chat
  const handleClearCurrentChat = () => {
    if (isLoading) {
      handleStopGeneration();
    }
    stopAllSpeech();
    setSessions((prev) =>
      prev.map((s) =>
        s.id === currentSessionId
          ? { ...s, messages: [], title: currentMode === 'image-studio' ? 'AI Image Studio' : 'New Chat', updatedAt: Date.now() }
          : s
      )
    );
  };

  // Stop generation
  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
    setStreamingMessageId(null);
  };

  const getSystemInstruction = (): string => {
    let instruction = `You are PC CHAT, a professional, high-performance AI assistant.\n`;

    if (selectedLanguage === 'hi') {
      instruction += `IMPORTANT LANGUAGE RULE: The user has selected Hindi mode. Respond strictly in clear, natural, and polite Hindi (or Hinglish if the user's prompt is in Hinglish).\n`;
    } else if (selectedLanguage === 'en') {
      instruction += `IMPORTANT LANGUAGE RULE: Respond in polished, articulate English.\n`;
    } else {
      instruction += `IMPORTANT LANGUAGE RULE: You are bilingual in Hindi and English. Match the language of the user's prompt (Hindi for Hindi/Hinglish, English for English). Provide bilingual clarification when helpful.\n`;
    }

    if (customPersona === 'concise') {
      instruction += `Style: Be very concise, direct, and to the point. Avoid conversational filler.\n`;
    } else if (customPersona === 'coder') {
      instruction += `Style: You are an expert software architect. Provide clean, production-ready, typed code with explanation of caveats and performance.\n`;
    } else if (customPersona === 'teacher') {
      instruction += `Style: Explain concepts step-by-step with clear analogies, patient tone, and practical examples.\n`;
    }

    return instruction;
  };

  // Feature 1: Real AI Image Generator Handler
  const handleGenerateImage = async (prompt: string, aspectRatio: string = '1:1') => {
    if (!prompt.trim() || isLoading) return;
    stopAllSpeech();

    const userMessage: Message = {
      id: 'msg-' + Date.now(),
      role: 'user',
      content: prompt.trim(),
      timestamp: Date.now(),
      isImagePrompt: true,
    };

    const aiMessageId = 'msg-ai-img-' + (Date.now() + 1);
    const aiPlaceholder: Message = {
      id: aiMessageId,
      role: 'assistant',
      content: 'Generating AI image with Google image models...',
      timestamp: Date.now() + 1,
    };

    const isFirstMessage = !currentSession || currentSession.messages.length === 0;
    const newTitle = isFirstMessage
      ? `Image: ${prompt.length > 24 ? prompt.substring(0, 24) + '...' : prompt}`
      : currentSession.title;

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === currentSessionId) {
          return {
            ...s,
            title: newTitle,
            mode: 'image-studio',
            messages: [...s.messages, userMessage, aiPlaceholder],
            updatedAt: Date.now(),
          };
        }
        return s;
      })
    );

    setIsLoading(true);
    setStreamingMessageId(aiMessageId);

    try {
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, aspectRatio }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `Server error (${response.status})`);
      }

      if (data.imageUrl) {
        // Save generated image
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id === currentSessionId) {
              return {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === aiMessageId
                    ? {
                        ...m,
                        content: '',
                        generatedImage: {
                          url: data.imageUrl,
                          prompt: data.prompt || prompt,
                          aspectRatio: data.aspectRatio || aspectRatio,
                          model: data.model,
                        },
                      }
                    : m
                ),
                updatedAt: Date.now(),
              };
            }
            return s;
          })
        );
      } else {
        throw new Error('Image generation completed without image data.');
      }
    } catch (err: any) {
      console.error('Image generation error:', err);
      updateAiMessageError(aiMessageId, err?.message || 'Failed to generate image.');
    } finally {
      setIsLoading(false);
      setStreamingMessageId(null);
    }
  };

  // Feature 2: Multimodal Chat / Image Understanding Handler
  const handleSendMessage = async (text: string, imageAttachment?: ImageAttachment) => {
    if ((!text.trim() && !imageAttachment) || isLoading) return;
    stopAllSpeech();

    const userMessage: Message = {
      id: 'msg-' + Date.now(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      imageAttachment,
    };

    const aiMessageId = 'msg-ai-' + (Date.now() + 1);
    const aiPlaceholder: Message = {
      id: aiMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now() + 1,
    };

    const isFirstMessage = !currentSession || currentSession.messages.length === 0;
    const snippet = text || (imageAttachment ? 'Image Analysis' : 'New Chat');
    const newTitle = isFirstMessage
      ? snippet.length > 32
        ? snippet.substring(0, 32) + '...'
        : snippet
      : currentSession.title;

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === currentSessionId) {
          return {
            ...s,
            title: newTitle,
            messages: [...s.messages, userMessage, aiPlaceholder],
            updatedAt: Date.now(),
          };
        }
        return s;
      })
    );

    setIsLoading(true);
    setStreamingMessageId(aiMessageId);

    // Prepare history payload for API (including multimodal imageAttachments)
    const history = [...(currentSession ? currentSession.messages : []), userMessage];
    const payloadMessages = history.map((m) => ({
      role: m.role,
      content: m.content,
      imageAttachment: m.imageAttachment
        ? {
            dataUrl: m.imageAttachment.dataUrl,
            mimeType: m.imageAttachment.mimeType,
          }
        : undefined,
    }));

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    let accumulatedText = '';
    let streamSucceeded = false;

    try {
      // 1. Try streaming endpoint first
      try {
        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: payloadMessages,
            customSystemInstruction: getSystemInstruction(),
          }),
          signal: abortController.signal,
        });

        if (response.ok && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          let isStreamDone = false;

          while (!isStreamDone) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data: ')) {
                const dataStr = trimmed.slice(6).trim();
                if (dataStr === '[DONE]') {
                  isStreamDone = true;
                  break;
                }

                try {
                  const parsed = JSON.parse(dataStr);
                  if (parsed.error) {
                    throw new Error(parsed.error);
                  }
                  if (parsed.text) {
                    accumulatedText += parsed.text;
                    updateAiMessageContent(aiMessageId, accumulatedText);
                  }
                } catch (err: any) {
                  if (err.message && err.message !== 'Unexpected end of JSON input') {
                    console.warn('SSE parsing issue:', err);
                  }
                }
              }
            }
          }

          if (accumulatedText.trim().length > 0) {
            streamSucceeded = true;
          }
        }
      } catch (streamErr: any) {
        if (streamErr.name === 'AbortError') throw streamErr;
        console.warn('Streaming failed, trying non-streaming fallback...', streamErr);
      }

      // 2. If streaming produced no output, fallback to standard /api/chat
      if (!streamSucceeded && !abortController.signal.aborted) {
        const fallbackRes = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: payloadMessages,
            customSystemInstruction: getSystemInstruction(),
          }),
          signal: abortController.signal,
        });

        if (!fallbackRes.ok) {
          const errorData = await fallbackRes.json().catch(() => ({}));
          throw new Error(errorData.error || `Server error (${fallbackRes.status})`);
        }

        const data = await fallbackRes.json();
        const reply = data.reply || '';
        if (!reply.trim()) {
          throw new Error('Received blank response from Gemini API');
        }
        accumulatedText = reply;
        updateAiMessageContent(aiMessageId, reply);
      }

      // Auto Read Aloud (Requirement 11)
      if (voiceSettings.autoRead && accumulatedText.trim()) {
        handleToggleSpeak(aiMessageId, accumulatedText);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('Generation aborted by user');
      } else {
        console.error('Error generating chat response:', err);
        const errorMsg =
          err?.message || 'Sorry, could not connect to Gemini API. Please check your network and API key.';
        updateAiMessageError(aiMessageId, errorMsg);
      }
    } finally {
      setIsLoading(false);
      setStreamingMessageId(null);
      abortControllerRef.current = null;
    }
  };

  const updateAiMessageContent = (messageId: string, content: string) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === currentSessionId) {
          return {
            ...s,
            messages: s.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
            updatedAt: Date.now(),
          };
        }
        return s;
      })
    );
  };

  const updateAiMessageError = (messageId: string, errorContent: string) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === currentSessionId) {
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === messageId ? { ...m, content: errorContent, error: true } : m
            ),
            updatedAt: Date.now(),
          };
        }
        return s;
      })
    );
  };

  const handleRegenerate = () => {
    if (!currentSession || currentSession.messages.length < 2 || isLoading) return;

    const messages = currentSession.messages;
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }

    if (lastUserIndex === -1) return;

    const lastUserMsg = messages[lastUserIndex];

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === currentSessionId) {
          return {
            ...s,
            messages: s.messages.slice(0, lastUserIndex),
            updatedAt: Date.now(),
          };
        }
        return s;
      })
    );

    if (lastUserMsg.isImagePrompt) {
      handleGenerateImage(lastUserMsg.content, '1:1');
    } else {
      handleSendMessage(lastUserMsg.content, lastUserMsg.imageAttachment);
    }
  };

  const handleRetry = () => {
    handleRegenerate();
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#07090e] text-slate-100 select-none">
      {/* Sidebar for Desktop & Mobile (Feature 1 & Feature 3) */}
      {isSidebarOpen && (
        <Sidebar
          sessions={sessions}
          currentSessionId={currentSessionId}
          onSelectSession={(id) => {
            stopAllSpeech();
            setCurrentSessionId(id);
            const found = sessions.find((s) => s.id === id);
            setCurrentMode(found?.mode || 'chat');
          }}
          onNewChat={handleNewChat}
          onOpenImageStudio={handleOpenImageStudio}
          currentMode={currentMode}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onClearAllSessions={handleClearAllSessions}
          isOpen={isMobileSidebarOpen}
          onCloseMobile={() => setIsMobileSidebarOpen(false)}
          selectedLanguage={selectedLanguage}
          onChangeLanguage={setSelectedLanguage}
        />
      )}

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full min-w-0 bg-radial from-[#0d1424] via-[#070b13] to-[#04060a] relative">
        {/* Header */}
        <ChatHeader
          currentSession={currentSession}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => {
            if (window.innerWidth < 768) {
              setIsMobileSidebarOpen(!isMobileSidebarOpen);
            } else {
              setIsSidebarOpen(!isSidebarOpen);
            }
          }}
          onClearCurrentChat={handleClearCurrentChat}
          onOpenSettings={() => setIsSettingsOpen(true)}
          selectedLanguage={selectedLanguage}
          onChangeLanguage={setSelectedLanguage}
        />

        {/* Messages scroll area */}
        <div
          ref={chatContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-2 md:px-6 py-4 space-y-3 relative"
        >
          {currentSession?.messages.length === 0 ? (
            <EmptyState
              onSelectPrompt={(prompt) => {
                if (currentMode === 'image-studio') {
                  handleGenerateImage(prompt, '1:1');
                } else {
                  handleSendMessage(prompt);
                }
              }}
              selectedLanguage={selectedLanguage}
            />
          ) : (
            <div className="max-w-4xl mx-auto space-y-4">
              {currentSession.messages.map((message, idx) => {
                const isThisStreaming =
                  streamingMessageId === message.id && isLoading;
                const isLastAi =
                  message.role === 'assistant' &&
                  idx === currentSession.messages.length - 1;

                return (
                  <MessageItem
                    key={message.id}
                    message={message}
                    isStreaming={isThisStreaming}
                    onRegenerate={isLastAi ? handleRegenerate : undefined}
                    onRetry={message.error ? handleRetry : undefined}
                    onRegenerateImage={(prompt) => handleGenerateImage(prompt, '1:1')}
                    isCurrentlySpeaking={currentlySpeakingId === message.id}
                    onToggleSpeak={handleToggleSpeak}
                    speechRate={voiceSettings.rate}
                  />
                );
              })}
              <div ref={messagesEndRef} className="h-4" />
            </div>
          )}
        </div>

        {/* Floating scroll to bottom button */}
        {showScrollBottom && (
          <button
            onClick={() => scrollToBottom('smooth')}
            className="absolute bottom-28 right-6 z-20 p-2.5 rounded-full bg-slate-800/90 hover:bg-cyan-600 text-slate-300 hover:text-white border border-slate-700 hover:border-cyan-400 shadow-xl shadow-cyan-950/50 transition-all cursor-pointer animate-bounce"
            title="Scroll to bottom"
          >
            <ArrowDown className="w-4 h-4" />
          </button>
        )}

        {/* Input box with Multimodal Image upload & AI Image Generator controls */}
        <ChatInput
          onSendMessage={handleSendMessage}
          onGenerateImage={handleGenerateImage}
          isLoading={isLoading}
          onStop={handleStopGeneration}
          selectedLanguage={selectedLanguage}
          isImageStudioMode={currentMode === 'image-studio'}
          onSetImageStudioMode={(enabled) => setCurrentMode(enabled ? 'image-studio' : 'chat')}
        />
      </div>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        selectedLanguage={selectedLanguage}
        onChangeLanguage={setSelectedLanguage}
        customPersona={customPersona}
        onChangePersona={setCustomPersona}
        voiceSettings={voiceSettings}
        onChangeVoiceSettings={setVoiceSettings}
      />
    </div>
  );
}
