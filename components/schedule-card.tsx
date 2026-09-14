'use client';
import { useId, useState } from 'react';
import {
  ArrowUpRight,
  CalendarDays,
  Clock3,
  RefreshCw,
  GraduationCap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
export type ScheduleData = {
  group?: string;
  semester?: string;
  day?: string | null;
  date?: string;
  url: string;
  fetchedAt: string;
  mode: 'snapshot' | 'live';
  needsGroup?: boolean;
  availableGroups: string[];
  formattedAnswer: string;
  warnings?: string[];
  lessons?: Lesson[];
  weekLessons?: Lesson[];
};
type Lesson = {
  day: string;
  time: string;
  details: string;
  cell: string;
  sourceCell: string;
};
const days = [
  ['all', 'Вся неделя'],
  ['понедельник', 'Пн'],
  ['вторник', 'Вт'],
  ['среда', 'Ср'],
  ['четверг', 'Чт'],
  ['пятница', 'Пт'],
  ['суббота', 'Сб'],
  ['воскресенье', 'Вс'],
];
export function ScheduleCard({
  data,
  onChange,
}: {
  data: ScheduleData;
  onChange: (data: ScheduleData) => void;
}) {
  const [day, setDay] = useState(data.day || 'all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  async function load(group: string, refresh = false) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(
        '/api/schedule?' +
          new URLSearchParams({ group, refresh: String(refresh) }),
      );
      const next = (await r.json()) as ScheduleData & { error?: string };
      if (!r.ok)
        throw new Error(next.error || 'Не удалось загрузить расписание');
      onChange(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const lessons = data.weekLessons || data.lessons || [];
  const visibleDays = day === 'all' ? days.slice(1, 7).map((d) => d[0]) : [day];
  const count = lessons.filter((l) => day === 'all' || l.day === day).length;
  return (
    <section
      className="timetable"
      aria-label="Расписание занятий"
      aria-busy={busy}
    >
      <header className="timetable-header">
        <div className="timetable-icon">
          <CalendarDays size={23} />
        </div>
        <div>
          <div className="timetable-eyebrow">ИТИС · РАСПИСАНИЕ ЗАНЯТИЙ</div>
          <h2>{data.group ? `Группа ${data.group}` : 'Выбери свою группу'}</h2>
        </div>
        <span className="timetable-count">
          {data.group
            ? `${count} занятий`
            : `${data.availableGroups.length} групп`}
        </span>
      </header>
      <div className="timetable-controls">
        <div>
          <label htmlFor={id}>
            <GraduationCap size={15} /> Учебная группа
          </label>
          <NativeSelect
            id={id}
            value={data.group || ''}
            disabled={busy}
            onChange={(e) => void load(e.target.value)}
          >
            <NativeSelectOption value="" disabled>
              Выбрать группу
            </NativeSelectOption>
            {data.availableGroups.map((g) => (
              <NativeSelectOption
                key={g}
                value={g.trim().match(/11(?:\.1)?-\d{3}[а-яa-z]?/i)?.[0] || g}
              >
                {g.trim()}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void load(data.group || '', true)}
        >
          <RefreshCw size={15} className={busy ? 'spin' : ''} />
          {busy ? 'Загрузка…' : 'Обновить из таблицы'}
        </Button>
      </div>
      {error && (
        <p className="timetable-error" role="alert">
          {error} Сохранённое расписание остаётся доступным.
        </p>
      )}
      {data.needsGroup ? (
        <div className="timetable-empty">
          <CalendarDays size={28} />
          <p>
            Выбери номер группы выше — здесь появятся пары, время и аудитории.
          </p>
        </div>
      ) : (
        <>
          <p className="timetable-semester">
            {data.semester?.replace(
              /КФУ ИТИС\s*-?\s*РАСПИСАНИЕ ЗАНЯТИЙ НА /i,
              '',
            )}
          </p>
          <Tabs value={day} onValueChange={(value) => setDay(String(value))}>
            <TabsList className="timetable-tabs" aria-label="День недели">
              {days.map(([value, label]) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            {days.map(([value]) => (
              <TabsContent key={value} value={value}>
                {value === day && (
                  <div className="timetable-days">
                    {visibleDays.map((d) => {
                      const entries = lessons.filter((l) => l.day === d);
                      return (
                        <section className="timetable-day" key={d}>
                          <div className="timetable-day-heading">
                            <h3>{d}</h3>
                            <span>
                              {entries.length
                                ? `${entries.length} занятий`
                                : 'Нет записей'}
                            </span>
                          </div>
                          {entries.length ? (
                            entries.map((l, i) => {
                              const lines = l.details
                                .split('\n')
                                .map((t) => t.trim())
                                .filter(Boolean);
                              return (
                                <div
                                  className="lesson-card"
                                  key={l.cell + '-' + i}
                                >
                                  <div className="lesson-time">
                                    <Clock3 size={14} />
                                    <strong>{l.time.split('-')[0]}</strong>
                                    <span>{l.time.split('-')[1]}</span>
                                  </div>
                                  <div className="lesson-content">
                                    <h4>{lines[0]}</h4>
                                    <p>{lines.slice(1).join('\n')}</p>
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <p className="no-lessons">
                              На этот день в таблице нет занятий для группы.
                            </p>
                          )}
                        </section>
                      );
                    })}
                  </div>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </>
      )}
      <footer className="timetable-footer">
        <div className="timetable-origin">
          <span
            className={
              'status-dot' + (data.mode === 'snapshot' ? ' amber' : '')
            }
          />
          {data.mode === 'snapshot'
            ? 'Сохранённая копия'
            : 'Загружено из Google Sheets'}{' '}
          ·{' '}
          {new Date(data.fetchedAt).toLocaleString('ru-RU', {
            timeZone: 'Europe/Moscow',
            dateStyle: 'short',
            timeStyle: 'short',
          })}{' '}
          МСК
        </div>
        <p>
          Условия по неделям, подгруппам и отменам сохранены в тексте пар. Для
          конкретной даты показан шаблон дня недели; чётность недели и каникулы
          автоматически не учитываются.
        </p>
        <a href={data.url} target="_blank" rel="noreferrer">
          Открыть исходную таблицу <ArrowUpRight size={14} />
        </a>
      </footer>
    </section>
  );
}
