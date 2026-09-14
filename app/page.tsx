'use client';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Globe,
  GraduationCap,
  KeyRound,
  LoaderCircle,
  Plus,
  Search,
  Terminal,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { ScheduleCard, type ScheduleData } from '@/components/schedule-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
type Source = { title: string; url: string; fetchedAt?: string };
type Step = {
  name: string;
  arguments?: Record<string, unknown>;
  status: string;
  detail?: string;
};
type Message = {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  schedule?: ScheduleData;
};
type Status = {
  configured: boolean;
  model: string;
  mcp: boolean;
  pages: number;
};
const suggestions = [
  {
    label: 'Поступление',
    question:
      'Какие направления подготовки есть в ИТИС и где посмотреть условия поступления?',
    icon: GraduationCap,
  },
  {
    label: 'Расписание группы',
    question: 'Покажи расписание моей группы',
    icon: BookOpen,
  },
  {
    label: 'Контакты',
    question: 'Где находится ИТИС и как связаться с институтом?',
    icon: Globe,
  },
  {
    label: 'Студенческая жизнь',
    question: 'Какие стипендиальные программы доступны студентам ИТИС?',
    icon: Search,
  },
];
export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('google/gemini-2.5-flash');
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  async function refresh() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) throw new Error();
      const data = (await r.json()) as Status;
      setStatus(data);
      setModel(data.model);
    } catch {
      setError(
        'Не удаётся связаться с сервером. Запусти файл «Запустить.command» в папке проекта.',
      );
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, phase]);
  async function save() {
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, model }),
      });
      const data = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(data.error);
      setKey('');
      setSettings(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function ask(text = question) {
    if (!text.trim() || busy) return;
    const history = [
      ...messages,
      { role: 'user' as const, content: text.trim() },
    ];
    setMessages(history);
    setQuestion('');
    setBusy(true);
    setSteps([]);
    setSources([]);
    setError('');
    setPhase('Подключаю инструменты…');
    controller.current = new AbortController();
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history
            .slice(-16)
            .map(({ role, content, schedule }) => ({
              role,
              content: schedule
                ? `Расписание группы ${schedule.group || 'не выбрана'}, день: ${schedule.day || 'неделя'}`
                : content.slice(0, 9000),
            })),
        }),
        signal: controller.current.signal,
      });
      if (!r.ok) {
        const data = (await r.json()) as { error?: string };
        throw new Error(data.error || 'Ошибка сервера');
      }
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === 'status') setPhase(event.message);
          if (event.type === 'tool') setSteps((prev) => [...prev, event.step]);
          if (event.type === 'sources') setSources(event.sources);
          if (event.type === 'answer') {
            setMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: event.content,
                sources: event.sources,
                schedule: event.schedule,
              },
            ]);
            setSources(event.sources);
          }
          if (event.type === 'error') throw new Error(event.message);
        }
      }
    } catch (e) {
      setError(
        (e as Error).name === 'AbortError'
          ? 'Запрос остановлен.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
      setPhase('');
      void refresh();
    }
  }
  return (
    <div className="workspace">
      <aside className="identity-panel">
        <a className="brand" href="/" aria-label="ИТИС Навигатор, главная">
          <span className="brand-mark">
            и<span>т</span>
          </span>
          <span>
            ИТИС<span className="brand-sub">НАВИГАТОР</span>
          </span>
        </a>
        <div className="institution">
          Казанский федеральный
          <br />
          университет
        </div>
        <Button
          className="new-chat"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setMessages([]);
            setSources([]);
            setSteps([]);
            setError('');
          }}
        >
          <Plus size={17} /> Новый диалог
        </Button>
        <div className="side-label">ПОД РУКОЙ</div>
        <a
          className="side-link"
          href="https://kpfu.ru/itis"
          target="_blank"
          rel="noreferrer"
        >
          <Globe size={17} /> Сайт ИТИС <ArrowUpRight size={15} />
        </a>
        <a
          className="side-link"
          href="https://admissions.kpfu.ru/"
          target="_blank"
          rel="noreferrer"
        >
          <GraduationCap size={17} /> Абитуриенту <ArrowUpRight size={15} />
        </a>
        <div className="side-bottom">
          <div className="local-label">
            <span className="status-dot" /> Локальное приложение
          </div>
          <p>
            Учебный проект · MCP + LLM
            <br />
            Неофициальный помощник
          </p>
          <Button
            variant="ghost"
            className="settings-button"
            onClick={() => setSettings(!settings)}
          >
            <KeyRound size={16} />{' '}
            {status?.configured ? 'Настройки модели' : 'Подключить OpenRouter'}
          </Button>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="mobile-brand">ИТИС / </span>Помощник по институту
          </div>
          <button className="model-chip" onClick={() => setSettings(!settings)}>
            <span
              className={status?.configured ? 'status-dot' : 'status-dot amber'}
            />
            {status?.configured ? 'OpenRouter подключён' : 'Нужен API-ключ'}
          </button>
        </header>
        {settings && (
          <section className="settings-card" aria-label="Настройки OpenRouter">
            <div className="section-title">
              <h2>Подключение OpenRouter</h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSettings(false)}
                aria-label="Закрыть настройки"
              >
                <X />
              </Button>
            </div>
            <p>
              Создай{' '}
              <a
                href="https://openrouter.ai/settings/keys"
                target="_blank"
                rel="noreferrer"
              >
                API-ключ
              </a>{' '}
              и вставь его ниже. Он сохранится только в локальном файле .env.
            </p>
            <label htmlFor="api-key">
              API-ключ {status?.configured && '(пустое поле сохранит текущий)'}
            </label>
            <Input
              id="api-key"
              type="password"
              autoComplete="off"
              placeholder="sk-or-v1-…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <label htmlFor="model">Модель</label>
            <NativeSelect
              id="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <NativeSelectOption value="google/gemini-2.5-flash">
                Gemini 2.5 Flash
              </NativeSelectOption>
              <NativeSelectOption value="openai/gpt-4o-mini">
                GPT-4o mini
              </NativeSelectOption>
              <NativeSelectOption value="openrouter/free">
                Бесплатная — возможны очереди и лимиты
              </NativeSelectOption>
            </NativeSelect>
            <Button
              onClick={save}
              disabled={saving || (!key && !status?.configured)}
            >
              {saving ? 'Сохраняю…' : 'Сохранить подключение'}
            </Button>
          </section>
        )}
        <div className="conversation">
          {messages.length === 0 ? (
            <section className="welcome">
              <div className="eyebrow">
                <span /> ЗНАКОМСТВО С ИТИС
              </div>
              <h1>
                Твой вопрос.
                <br />
                <span>Ответ с источниками.</span>
              </h1>
              <p className="intro">
                Поступление, учёба и жизнь в институте.
                <br />
                Найду информацию на официальных сайтах КФУ.
              </p>
              <div className="suggestions">
                {suggestions.map(({ label, question: q, icon: Icon }) => (
                  <button
                    key={label}
                    onClick={() => void ask(q)}
                    className="suggestion"
                  >
                    <Icon size={21} />
                    <span>
                      <strong>{label}</strong>
                      <span>{q}</span>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
              <div className="welcome-note">
                <Globe size={15} /> Поиск по официальным страницам · Ссылки в
                каждом ответе
              </div>
            </section>
          ) : (
            <div className="messages">
              {messages.map((m, i) => (
                <article key={i} className={`message ${m.role}`}>
                  <div className="message-label">
                    {m.role === 'user' ? 'ТЫ' : 'ИТИС НАВИГАТОР'}
                  </div>
                  <div className="message-content">
                    {m.schedule ? (
                      <ScheduleCard
                        data={m.schedule}
                        onChange={(data) =>
                          setMessages((prev) =>
                            prev.map((msg, index) =>
                              index === i
                                ? {
                                    ...msg,
                                    schedule: data,
                                    content: data.formattedAnswer,
                                  }
                                : msg,
                            ),
                          )
                        }
                      />
                    ) : (
                      <ReactMarkdown
                        components={{
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noreferrer">
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {m.content}
                      </ReactMarkdown>
                    )}
                  </div>
                  {!m.schedule && m.sources && m.sources.length > 0 && (
                    <div className="answer-sources">
                      {m.sources.slice(0, 5).map((s, i) => (
                        <a
                          key={s.url}
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span>{i + 1}</span>
                          {s.title}
                          <ArrowUpRight size={13} />
                        </a>
                      ))}
                    </div>
                  )}
                </article>
              ))}
              {busy && (
                <div className="thinking" role="status">
                  <LoaderCircle className="spin" size={18} />
                  {phase}
                </div>
              )}
              <div ref={end} />
            </div>
          )}
        </div>
        <div className="composer-area">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <Textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={2500}
              placeholder="Что хочешь узнать об ИТИС?"
              aria-label="Вопрос об ИТИС"
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void ask();
                }
              }}
            />
            <div className="composer-bottom">
              <span>
                <Search size={14} /> КФУ и таблица расписания
              </span>
              {busy ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => controller.current?.abort()}
                >
                  Остановить
                </Button>
              ) : (
                <Button
                  type="submit"
                  className="send-button"
                  disabled={!question.trim()}
                  aria-label="Отправить вопрос"
                >
                  <ArrowUp size={20} />
                </Button>
              )}
            </div>
          </form>
          <p className="disclaimer">
            Даты и условия могут меняться — проверяй первоисточник.
          </p>
        </div>
      </main>
      <aside className="research-panel">
        <div className="research-heading">
          <Terminal size={18} />
          <h2>За кулисами ответа</h2>
        </div>
        <p className="research-intro">
          Здесь видно, как помощник работает с информацией.
        </p>
        <div className="connection">
          <span className={status?.mcp ? 'status-dot' : 'status-dot amber'} />
          <span>MCP-сервер</span>
          <b>{status?.mcp ? 'подключён' : 'подключение…'}</b>
        </div>
        <div className="side-label">ХОД ПОИСКА</div>
        {steps.length ? (
          <ol className="steps">
            {steps.map((s, i) => (
              <li key={i}>
                <span className="step-icon">
                  {s.status === 'error' ? <X size={13} /> : <Check size={13} />}
                </span>
                <div>
                  <strong>
                    {s.name === 'get_group_schedule'
                      ? 'Расписание группы'
                      : s.name === 'search_kfu'
                        ? 'Поиск по КФУ'
                        : s.name === 'read_kfu_page'
                          ? 'Чтение страницы'
                          : s.name}
                  </strong>
                  <p>
                    {String(
                      s.arguments?.group ||
                        s.arguments?.query ||
                        s.arguments?.url ||
                        s.detail ||
                        '',
                    )}
                  </p>
                  <small>{s.detail}</small>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty-research">
            <Search size={23} />
            <p>Задай вопрос — здесь появятся вызовы инструментов.</p>
          </div>
        )}
        <div className="side-label">
          НАЙДЕННЫЕ ИСТОЧНИКИ {sources.length > 0 && `· ${sources.length}`}
        </div>
        {sources.length ? (
          <div className="source-list">
            {sources.map((s, i) => (
              <a href={s.url} key={s.url} target="_blank" rel="noreferrer">
                <span className="source-number">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span>
                  <strong>{s.title}</strong>
                  <small>
                    {new URL(s.url).hostname}
                    {s.fetchedAt &&
                      ` · ${new Date(s.fetchedAt).toLocaleDateString('ru-RU')}`}
                  </small>
                </span>
                <ArrowUpRight size={14} />
              </a>
            ))}
          </div>
        ) : (
          <p className="source-placeholder">
            Только реальные страницы,
            <br />
            найденные во время поиска.
          </p>
        )}
        <div className="protocol-note">
          <span>MCP</span>
          <p>
            Модель выбирает инструмент.
            <br />
            Сервер получает данные.
            <br />
            Ответ опирается на источники.
          </p>
        </div>
      </aside>
    </div>
  );
}
