// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageCircle, X, Send, Loader2, Bot, User, Code, Database, AlertCircle, Copy, Check, Play, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { type Asset, getAssetId } from '../api';
import { httpClient } from '../lib/httpClient';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  toolInfo?: {
    tool: string;
    input?: string;
    output?: string;
  };
  codeBlocks?: {
    language: string;
    code: string;
  }[];
  apiCard?: ApiCardData;
}

interface ApiCardData {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  description: string;
  params: ApiParam[];
}

interface ApiParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  default?: string | number | boolean;
  required?: boolean;
}

interface ApiCardResultPreview {
  url?: string;
  status?: number;
  data_preview?: unknown;
}

interface ApiCardParamMeta {
  type?: string;
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
}

interface ApiCardPayload {
  endpoint?: string;
  method?: string;
  description?: string;
  params?: Record<string, ApiCardParamMeta>;
  last_result?: ApiCardResultPreview;
}

const getFeatureCount = (value: unknown): number | null => {
  if (!value || typeof value !== 'object') return null;
  const maybeFeatures = (value as { features?: unknown }).features;
  return Array.isArray(maybeFeatures) ? maybeFeatures.length : null;
};

// API definitions for interactive testing
const API_DEFINITIONS: Record<string, ApiCardData> = {
  '/v1/assets': {
    endpoint: '/v1/assets',
    method: 'GET',
    description: 'Lấy danh sách tài sản (nội bộ)',
    params: [
      { name: 'skip', type: 'number', description: 'Số bản ghi bỏ qua', default: 0, required: false },
      { name: 'limit', type: 'number', description: 'Số bản ghi tối đa', default: 50, required: false },
      { name: 'feature_type', type: 'string', description: 'Lọc theo loại', default: '', required: false },
    ]
  },
  '/v1/iot/sensors': {
    endpoint: '/v1/iot/sensors',
    method: 'GET',
    description: 'Lấy danh sách cảm biến IoT',
    params: [
      { name: 'skip', type: 'number', description: 'Số bản ghi bỏ qua', default: 0, required: false },
      { name: 'limit', type: 'number', description: 'Số bản ghi tối đa', default: 50, required: false },
      { name: 'sensor_type', type: 'string', description: 'Loại cảm biến', default: '', required: false },
      { name: 'status', type: 'string', description: 'Trạng thái (online/offline)', default: '', required: false },
    ]
  },
  '/v1/incidents': {
    endpoint: '/v1/incidents',
    method: 'GET',
    description: 'Lấy danh sách sự cố hạ tầng',
    params: [
      { name: 'skip', type: 'number', description: 'Số bản ghi bỏ qua', default: 0, required: false },
      { name: 'limit', type: 'number', description: 'Số bản ghi tối đa', default: 50, required: false },
      { name: 'status', type: 'string', description: 'Trạng thái (open/in_progress/resolved)', default: '', required: false },
      { name: 'severity', type: 'string', description: 'Mức độ (low/medium/high/critical)', default: '', required: false },
    ]
  },
};

// The assistant talks to the City service, which proxies the Tier-2
// AI capability (→ Tier-1 inference). No WebSocket: the REST route is the
// published contract.
const API_BASE_URL = import.meta.env.VITE_BASE_API_URL?.replace('/v1', '') || '';

// API Card Component
function ApiCard({ apiData, onClose, initialResult }: {
  apiData: ApiCardData;
  onClose: () => void;
  initialResult?: ApiCardResultPreview;
}) {
  const [params, setParams] = useState<Record<string, string | number>>(() => {
    const initial: Record<string, string | number> = {};
    apiData.params.forEach(p => {
      initial[p.name] = typeof p.default === 'boolean' ? String(p.default) : (p.default ?? '');
    });
    return initial;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<unknown>(initialResult?.data_preview || null);
  const [error, setError] = useState<string | null>(null);
  const [showResult, setShowResult] = useState(!!initialResult);
  const [copiedResult, setCopiedResult] = useState(false);
  const featureCount = getFeatureCount(result);

  const buildUrl = () => {
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== '' && value !== undefined) {
        queryParams.append(key, String(value));
      }
    });
    const queryString = queryParams.toString();
    return `${API_BASE_URL}${apiData.endpoint}${queryString ? '?' + queryString : ''}`;
  };

  const callApi = async () => {
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const url = buildUrl();
      const response = await fetch(url, {
        method: apiData.method,
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setResult(data);
      setShowResult(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
    } finally {
      setIsLoading(false);
    }
  };

  const copyResult = () => {
    if (result) {
      navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      setCopiedResult(true);
      setTimeout(() => setCopiedResult(false), 2000);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-blue-200 overflow-hidden shadow-lg">
      {/* Header */}
      <div className="px-4 py-3 border-b border-blue-100 flex items-center justify-between bg-gradient-to-r from-blue-50 to-cyan-50">
        <div className="flex items-center gap-2">
          <Code size={16} className="text-blue-500" />
          <span className="font-mono text-sm text-slate-700 font-semibold">Trình kiểm thử API</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition">
          <X size={16} />
        </button>
      </div>

      {/* Endpoint Info */}
      <div className="px-4 py-3 border-b border-blue-100">
        <div className="flex items-center gap-2 mb-1">
          <span className={`px-2 py-0.5 rounded text-xs font-bold text-white ${apiData.method === 'GET' ? 'bg-green-500' :
            apiData.method === 'POST' ? 'bg-blue-500' :
              apiData.method === 'PUT' ? 'bg-amber-500' : 'bg-red-500'
            }`}>
            {apiData.method}
          </span>
          <code className="text-sm text-blue-600 font-mono">{apiData.endpoint}</code>
        </div>
        <p className="text-xs text-slate-500">{apiData.description}</p>
      </div>

      {/* Parameters */}
      {apiData.params.length > 0 && (
        <div className="px-4 py-3 border-b border-blue-100 space-y-3">
          <div className="text-xs text-slate-500 uppercase font-semibold tracking-wide">Tham số</div>
          {apiData.params.map(param => (
            <div key={param.name} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-600 font-mono">
                  {param.name}
                  {param.required && <span className="text-red-500 ml-1">*</span>}
                </label>
                <span className="text-xs text-slate-400">({param.type})</span>
              </div>
              <input
                type={param.type === 'number' ? 'number' : 'text'}
                value={params[param.name] ?? ''}
                onChange={(e) => setParams(prev => ({
                  ...prev,
                  [param.name]: param.type === 'number' ? (e.target.value ? Number(e.target.value) : '') : e.target.value
                }))}
                placeholder={param.description}
                className="w-full px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition"
              />
            </div>
          ))}
        </div>
      )}

      {/* URL Preview */}
      <div className="px-4 py-2 border-b border-blue-100 bg-slate-50">
        <div className="flex items-center gap-2">
          <ExternalLink size={12} className="text-slate-400" />
          <code className="text-xs text-slate-500 break-all">{buildUrl()}</code>
        </div>
      </div>

      {/* Call Button */}
      <div className="px-4 py-3 border-b border-blue-100">
        <button
          onClick={callApi}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-semibold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
        >
          {isLoading ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              <span>Đang gọi API...</span>
            </>
          ) : (
            <>
              <Play size={16} />
              <span>Gọi API</span>
            </>
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-3 bg-red-50 border-b border-red-200">
          <div className="flex items-center gap-2 text-red-600">
            <AlertCircle size={14} />
            <span className="text-sm">{error}</span>
          </div>
        </div>
      )}

      {/* Result */}
      {Boolean(result) && (
        <div className="border-t border-blue-100">
          <button
            onClick={() => setShowResult(!showResult)}
            className="w-full px-4 py-2 flex items-center justify-between text-sm text-slate-600 hover:bg-blue-50 transition"
          >
            <span className="flex items-center gap-2">
              <Database size={14} className="text-green-500" />
              <span>Kết quả</span>
              {featureCount !== null && (
                <span className="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded-full">
                  {featureCount} mục
                </span>
              )}
            </span>
            {showResult ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {showResult && (
            <div className="relative">
              <button
                onClick={copyResult}
                className="absolute top-2 right-2 p-1.5 bg-slate-200 hover:bg-slate-300 rounded text-slate-500 hover:text-slate-700 transition z-10"
                title="Sao chép JSON"
              >
                {copiedResult ? <Check size={12} /> : <Copy size={12} />}
              </button>
              <pre className="px-4 py-3 text-xs text-slate-700 bg-slate-50 overflow-auto max-h-60 font-mono border-t border-blue-100">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface AIChatWidgetProps {
  selectedAsset?: Asset | null;
  onOpenChange?: (isOpen: boolean) => void;
  openChat?: boolean;
  addAssetToContext?: Asset | null;
}

/** Welcome copy mirrors the live Tier-2 status probe. */
const welcomeFor = (status: AiStatus): string => {
  switch (status) {
    case 'ready':
      return 'Xin chào! Tôi là trợ lý AI của SynapseCity. Bạn có thể hỏi về dữ liệu tài sản, cảm biến và sự cố hạ tầng của bạn.';
    case 'degraded':
      return 'Xin chào! Trợ lý AI đang ở chế độ suy giảm hiệu năng (upstream không ổn định). Bạn vẫn có thể thử đặt câu hỏi.';
    case 'unavailable':
      return 'Trợ lý AI chưa khả dụng: dịch vụ suy luận ở Tier-2 chưa sẵn sàng hoặc chưa được cấu hình. Bạn vẫn có thể dùng công cụ kiểm thử API bên dưới và xem dữ liệu tài sản trực tiếp.';
    default:
      return 'Đang kiểm tra kết nối tới trợ lý AI…';
  }
};

type AiStatus = 'checking' | 'ready' | 'degraded' | 'unavailable';

export default function AIChatWidget({ 
  selectedAsset, 
  onOpenChange,
  openChat,
  addAssetToContext: externalAddAsset
}: AIChatWidgetProps = {}) {
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const isOpen = openChat ?? internalIsOpen;
  const [assetInContext, setAssetInContext] = useState<Asset | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus>('checking');
  const [messages, setMessages] = useState<Message[]>([]);
  const [welcomeAt] = useState(() => new Date());
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingMessageRef = useRef<string>('');

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    httpClient.get('/ai/status')
      .then((response) => {
        if (cancelled) return;
        const status = String((response.data as { status?: string } | null)?.status || '').toLowerCase();
        setAiStatus(status === 'ready' ? 'ready' : status === 'degraded' ? 'degraded' : 'unavailable');
      })
      .catch(() => {
        if (!cancelled) setAiStatus('unavailable');
      });
    return () => { cancelled = true; };
  }, []);

  const addAssetToContext = useCallback((asset: Asset) => {
    setAssetInContext(asset);
    // Add a system message to inform the user
    const assetInfo = `Đã thêm tài sản vào ngữ cảnh:\n• Loại: ${asset.feature_type}\n• Mã: ${asset.feature_code}\n• ID: ${getAssetId(asset).slice(-6)}`;
    setMessages(prev => [...prev, {
      id: `asset-${Date.now()}`,
      role: 'system',
      content: `✅ ${assetInfo}\n\nBạn có thể đặt câu hỏi về tài sản này!`,
      timestamp: new Date(),
    }]);
  }, []);

  // Handle external asset addition - use ref to track previous value
  const prevAssetRef = useRef<Asset | null>(null);
  useEffect(() => {
    let timeoutId: number | undefined;

    if (externalAddAsset && getAssetId(externalAddAsset) !== (prevAssetRef.current ? getAssetId(prevAssetRef.current) : null)) {
      const nextAsset = externalAddAsset;
      timeoutId = window.setTimeout(() => {
        addAssetToContext(nextAsset);
        prevAssetRef.current = nextAsset;
      }, 0);
    }

    // Reset ref when external asset is cleared
    if (!externalAddAsset) {
      prevAssetRef.current = null;
    }

    return () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [externalAddAsset, addAssetToContext]);

  // Reset asset in context when selected asset changes (user needs to re-add it)
  useEffect(() => {
    if (selectedAsset && assetInContext && getAssetId(selectedAsset) !== getAssetId(assetInContext)) {
      const timeoutId = window.setTimeout(() => {
        setAssetInContext(null);
      }, 0);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }
  }, [selectedAsset, assetInContext]);

  const handleOpenChange = (open: boolean) => {
    if (openChat === undefined) {
      setInternalIsOpen(open);
    }
    onOpenChange?.(open);
  };

  const updateStreamingMessage = useCallback((content: string) => {
    setMessages(prev => {
      const lastMessage = prev[prev.length - 1];
      if (lastMessage?.role === 'assistant' && lastMessage.id === 'streaming') {
        return [
          ...prev.slice(0, -1),
          { ...lastMessage, content, timestamp: new Date() }
        ];
      }
      return prev;
    });
  }, []);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    streamingMessageRef.current = '';

    // Add placeholder for assistant message
    const assistantMessage: Message = {
      id: 'streaming',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, assistantMessage]);

    // Build chat history (last 10 messages, excluding the synthetic welcome)
    const history = messages
      .filter(m => m.role !== 'system')
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));

    // Include asset context if available
    const assetContext = assetInContext ? {
      asset_id: getAssetId(assetInContext),
      feature_type: assetInContext.feature_type,
      feature_code: assetInContext.feature_code,
      geometry: assetInContext.geometry,
    } : null;

    try {
      // Authenticated via the shared axios client (Bearer). City proxies the
      // Tier-2 AI capability; upstream failures surface as typed 503s.
      const response = await httpClient.post('/ai/chat', {
        message: userMessage.content,
        history,
        asset_context: assetContext,
      });
      const data = (response.data ?? {}) as {
        message?: string;
        model?: string;
        error?: string;
        detail?: string;
        dependency?: string;
      };
      const reply = String(data.message || '').trim();
      updateStreamingMessage(reply || '⚠️ Phản hồi rỗng từ dịch vụ AI. Vui lòng thử lại.');
    } catch (error) {
      const axiosError = error as { response?: { status?: number; data?: { error?: string; detail?: string; dependency?: string } } };
      const status = axiosError?.response?.status;
      const body = axiosError?.response?.data;
      if (status) {
        updateStreamingMessage(`❌ Trợ lý AI chưa khả dụng (HTTP ${status}): ${body?.detail || body?.error || 'ai_capability_unavailable'}${body?.dependency ? `\n${body.dependency}` : ''}`);
      } else {
        console.error('Chat error:', error);
        updateStreamingMessage('❌ Không thể kết nối. Vui lòng thử lại.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };


  // Parse code blocks from message content
  const renderMessage = (content: string) => {
    // First, convert <tool_output> and <tool_code> tags to code blocks
    const processedContent = content
      .replace(
        /<tool_output>([\s\S]*?)<\/tool_output>/g,
        (_, output) => '```json\n' + output.trim() + '\n```'
      )
      .replace(
        /<tool_code>([\s\S]*?)<\/tool_code>/g,
        (_, code) => '```python\n' + code.trim() + '\n```'
      );

    const parts = processedContent.split(/(```[\s\S]*?```)/g);

    return parts.map((part, idx) => {
      if (part.startsWith('```')) {
        const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
        if (match) {
          const lang = match[1] || 'text';
          const code = match[2].trim();

          // Handle api_card special block - parse and show interactive card
          if (lang === 'api_card') {
            try {
              const apiCardData = JSON.parse(code) as ApiCardPayload;
              // Extract endpoint from the api_card data
              const endpoint = typeof apiCardData.endpoint === 'string' ? apiCardData.endpoint : '';

              // Find matching API definition or create from response
              let matchedApi = Object.values(API_DEFINITIONS).find(
                api => endpoint.includes(api.endpoint) || api.endpoint.includes(endpoint)
              );

              if (!matchedApi && endpoint) {
                // Create dynamic API card from response data
                const params: ApiParam[] = [];
                if (apiCardData.params) {
                  Object.entries(apiCardData.params).forEach(([name, info]) => {
                    const rawType = info.type;
                    const normalizedType: ApiParam['type'] =
                      rawType === 'int' || rawType === 'number'
                        ? 'number'
                        : rawType === 'boolean'
                          ? 'boolean'
                          : 'string';
                    params.push({
                      name,
                      type: normalizedType,
                      description: info.description || '',
                      default: info.default,
                      required: info.required || false
                    });
                  });
                }

                const method: ApiCardData['method'] =
                  apiCardData.method === 'POST' ||
                  apiCardData.method === 'PUT' ||
                  apiCardData.method === 'DELETE'
                    ? apiCardData.method
                    : 'GET';

                matchedApi = {
                  endpoint: endpoint,
                  method,
                  description: apiCardData.description || '',
                  params
                };
              }

              if (matchedApi) {
                return (
                  <div key={idx} className="my-3">
                    <ApiCard
                      apiData={matchedApi}
                      onClose={() => { }}
                      initialResult={apiCardData.last_result}
                    />
                  </div>
                );
              }
            } catch (e) {
              console.error('Failed to parse api_card:', e);
            }
          }

          return (
            <div key={idx} className="my-2 rounded-lg overflow-hidden bg-slate-800 border border-slate-700">
              <div className="flex items-center justify-between px-3 py-1 bg-slate-900 text-xs text-slate-400">
                <span>{lang}</span>
                <button
                  onClick={() => copyCode(code)}
                  className="flex items-center gap-1 hover:text-white transition"
                >
                  {copiedCode === code ? (
                    <><Check size={12} /> Đã sao chép</>
                  ) : (
                    <><Copy size={12} /> Sao chép</>
                  )}
                </button>
              </div>
              <pre className="p-3 text-sm overflow-x-auto">
                <code className="text-green-400">{code}</code>
              </pre>
            </div>
          );
        }
      }

      // Handle bold text with **
      const processedText = part.split(/(\*\*[^*]+\*\*)/g).map((segment, segIdx) => {
        if (segment.startsWith('**') && segment.endsWith('**')) {
          return <strong key={segIdx} className="text-blue-600 font-semibold">{segment.slice(2, -2)}</strong>;
        }
        // Handle inline code with backticks
        return segment.split(/(`[^`]+`)/g).map((inlineSegment, inlineIdx) => {
          if (inlineSegment.startsWith('`') && inlineSegment.endsWith('`')) {
            return <code key={inlineIdx} className="bg-slate-100 px-1 rounded text-blue-600 border border-slate-200">{inlineSegment.slice(1, -1)}</code>;
          }
          return inlineSegment;
        });
      });

      // Regular text - preserve newlines
      return (
        <span key={idx} className="whitespace-pre-wrap">
          {processedText}
        </span>
      );
    });
  };

  return (
    <>
      {/* Chat button */}
      {!isOpen && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Chat button clicked');
            handleOpenChange(true);
          }}
          className="fixed bottom-6 right-6 p-4 bg-gradient-to-r from-blue-500 to-cyan-500 text-white rounded-full shadow-lg hover:shadow-xl transform hover:scale-105 transition-all z-[10000] flex items-center justify-center cursor-pointer"
          aria-label="Open AI Chat"
          title="Open AI Chat Assistant"
          style={{ 
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: 10000
          }}
        >
          <MessageCircle size={24} />
        </button>
      )}

      {/* Chat window */}
      {isOpen && (
        <div 
          className="fixed bottom-6 right-6 w-[440px] h-[650px] bg-white rounded-2xl shadow-2xl flex flex-col z-[10000] border border-blue-200 overflow-hidden"
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            width: '440px',
            height: '650px',
            zIndex: 10000,
            display: 'flex',
            visibility: 'visible',
            opacity: 1
          }}
          data-testid="chat-window"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-blue-500 to-cyan-500 text-white">
            <div className="flex items-center gap-2">
              <Bot size={20} />
              <div>
                <span className="font-semibold">SynapseCity AI</span>
                <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${
                  aiStatus === 'ready' ? 'bg-green-500/30' :
                  aiStatus === 'degraded' ? 'bg-amber-400/40 text-amber-950' :
                  aiStatus === 'checking' ? 'bg-white/20' : 'bg-red-500/30'
                }`}>
                  {aiStatus === 'ready' ? 'AI sẵn sàng' : aiStatus === 'degraded' ? 'AI suy giảm' : aiStatus === 'checking' ? 'Đang kết nối…' : 'AI chưa khả dụng'}
                </span>
              </div>
            </div>
            <button onClick={() => handleOpenChange(false)} className="hover:bg-white/20 p-1 rounded">
              <X size={20} />
            </button>
          </div>


          {/* Asset in Context Indicator */}
          {assetInContext && (
            <div className="px-4 py-2 border-b border-blue-100 bg-gradient-to-r from-blue-50 to-cyan-50">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                <p className="text-xs text-blue-700">
                  <span className="font-semibold">Ngữ cảnh:</span> {assetInContext.feature_type} ({assetInContext.feature_code})
                </p>
                <button
                  onClick={() => setAssetInContext(null)}
                  className="ml-auto text-xs text-blue-600 hover:text-blue-800 underline"
                >
                  Xóa
                </button>
              </div>
            </div>
          )}

          {/* Quick API Buttons */}
          <div className="px-3 py-2 border-b border-blue-100 bg-blue-50/50 flex gap-2 overflow-x-auto">
            {[
              { label: '📦 Tài sản', query: 'assets' },
              { label: '📡 Cảm biến', query: 'sensors' },
              { label: '🚨 Sự cố', query: 'incidents' },
            ].map(btn => (
              <button
                key={btn.query}
                onClick={() => {
                  setInput(`test api ${btn.query}`);
                  setTimeout(() => sendMessage(), 50);
                }}
                disabled={isLoading}
                className="flex-shrink-0 text-xs px-3 py-1.5 bg-white hover:bg-blue-50 text-blue-700 rounded-full transition border border-blue-200 hover:border-blue-400 disabled:opacity-50 shadow-sm"
              >
                {btn.label}
              </button>
            ))}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gradient-to-b from-blue-50/30 to-white">
            {[{ id: 'welcome', role: 'assistant' as const, content: welcomeFor(aiStatus), timestamp: welcomeAt }, ...messages].map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
              >
                <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${msg.role === 'user'
                  ? 'bg-blue-500'
                  : msg.role === 'system'
                    ? 'bg-amber-500'
                    : 'bg-gradient-to-r from-blue-500 to-cyan-500'
                  }`}>
                  {msg.role === 'user' ? <User size={16} /> : msg.role === 'system' ? <AlertCircle size={16} /> : <Bot size={16} />}
                </div>
                <div className={`max-w-[85%] rounded-2xl px-4 py-2 ${msg.role === 'user'
                  ? 'bg-blue-500 text-white'
                  : msg.role === 'system'
                    ? 'bg-amber-50 text-amber-800 border border-amber-200'
                    : 'bg-white text-slate-700 border border-blue-100 shadow-sm'
                  }`}>
                  {msg.role === 'assistant' && msg.content === '' && isLoading ? (
                    <div className="flex items-center gap-2">
                      <Loader2 size={16} className="animate-spin" />
                      <span className="text-slate-500">Đang xử lý...</span>
                    </div>
                  ) : (
                    renderMessage(msg.content)
                  )}
                </div>
              </div>
            ))}

            <div ref={messagesEndRef} />
          </div>

          <div className="p-4 border-t border-blue-100 bg-white">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                placeholder='Hỏi về API hoặc gõ "test api"...'
                className="flex-1 bg-blue-50 text-slate-700 rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 border border-blue-200 placeholder-slate-400"
                disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={isLoading || !input.trim()}
                className="bg-gradient-to-r from-blue-500 to-cyan-500 text-white p-2 rounded-xl hover:from-blue-600 hover:to-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed transition shadow-md"
              >
                {isLoading ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-2 text-center">
              SynapseCity AI • Truy vấn dữ liệu & kiểm thử API
            </p>
          </div>
        </div>
      )}
    </>
  );
}
