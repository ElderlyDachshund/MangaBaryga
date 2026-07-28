import {
  CircleAlert,
  ExternalLink,
  History,
  KeyRound,
  Lock,
  MousePointerClick,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BotSettings, TradeCard, TradeRecord, TradeStatus } from "../domain";
import {
  checkAuth,
  cancelAuth,
  completeAuth,
  loadState,
  saveSettings,
  startAuth,
  startBot,
  startCardLocking,
  stopBot,
  stopCardLocking,
  type ApiRuntimePass,
  type ApiSettings,
  type ApiState,
} from "./api";
import { Badge, type BadgeProps } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Select } from "./components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";

interface SettingsForm {
  telegramBotToken: string;
  telegramChatId: string;
  maxWantedPagesExclusive: string;
  lockAllWantedPagesThreshold: string;
  lockRecentWantedPagesThreshold: string;
  lockRecentCardsLimit: string;
  loopPauseMs: string;
  browserMode: BotSettings["browserMode"];
  safeMode: boolean;
  autoAcceptEnabled: boolean;
}

type TradeMode = "safe" | "auto";
type Message = { kind: "notice" | "error"; text: string } | undefined;

export function App() {
  const [state, setState] = useState<ApiState>();
  const [settingsForm, setSettingsForm] = useState<SettingsForm>(createEmptySettingsForm());
  const [message, setMessage] = useState<Message>();
  const [authMessage, setAuthMessage] = useState<Message>();
  const [cardMessage, setCardMessage] = useState<Message>();
  const [busyAction, setBusyAction] = useState<string>();

  const refreshState = useCallback(async (options: { syncSettings?: boolean } = {}) => {
    const nextState = await loadState();
    setState(nextState);

    if (options.syncSettings) {
      setSettingsForm((current) => mergeSettingsIntoForm(current, nextState.settings));
    }
  }, []);

  useEffect(() => {
    void refreshState({ syncSettings: true }).catch((error) => {
      setMessage({ kind: "error", text: formatError(error) });
    });

    const interval = window.setInterval(() => {
      void refreshState().catch(() => {});
    }, 5_000);

    return () => window.clearInterval(interval);
  }, [refreshState]);

  const metrics = useMemo(() => buildMetrics(state?.trades ?? []), [state?.trades]);

  async function runAction(name: string, action: () => Promise<void>): Promise<void> {
    setBusyAction(name);

    try {
      await action();
    } catch (error) {
      setMessage({ kind: "error", text: formatError(error) });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function runCardAction(name: string, action: () => Promise<void>): Promise<void> {
    setBusyAction(name);

    try {
      await action();
    } catch (error) {
      setCardMessage({ kind: "error", text: formatError(error) });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function saveSettingsForm(): Promise<void> {
    await runAction("save-settings", async () => {
      const patch = {
        telegramBotToken: settingsForm.telegramBotToken,
        telegramChatId: settingsForm.telegramChatId,
        maxWantedPagesExclusive: Number(settingsForm.maxWantedPagesExclusive),
        lockAllWantedPagesThreshold: Number(settingsForm.lockAllWantedPagesThreshold),
        lockRecentWantedPagesThreshold: Number(settingsForm.lockRecentWantedPagesThreshold),
        lockRecentCardsLimit: Number(settingsForm.lockRecentCardsLimit),
        loopPauseMs: Number(settingsForm.loopPauseMs),
        browserMode: settingsForm.browserMode,
        safeMode: settingsForm.safeMode,
        autoAcceptEnabled: settingsForm.autoAcceptEnabled,
      };

      const nextSettings = await saveSettings(patch);
      setSettingsForm((current) =>
        mergeSettingsIntoForm(
          {
            ...current,
            telegramBotToken: "",
            telegramChatId: "",
          },
          nextSettings,
        ),
      );
      setMessage({ kind: "notice", text: "Настройки сохранены." });
      await refreshState();
    });
  }

  async function switchTradeMode(mode: TradeMode): Promise<void> {
    await runAction(`switch-mode-${mode}`, async () => {
      const nextSettings = await saveSettings(buildTradeModePatch(mode));

      setSettingsForm((current) => mergeSettingsIntoForm(current, nextSettings));
      setMessage({
        kind: "notice",
        text: mode === "auto" ? "Включён режим принятия обменов." : "Включён безопасный режим.",
      });
      await refreshState();
    });
  }

  async function beginCardLocking(mode: "all" | "recent"): Promise<void> {
    const threshold = Number(
      mode === "all"
        ? settingsForm.lockAllWantedPagesThreshold
        : settingsForm.lockRecentWantedPagesThreshold,
    );
    const recentLimit = mode === "recent" ? Number(settingsForm.lockRecentCardsLimit) : undefined;
    const scopeText =
      mode === "all" ? "все карты аккаунта" : `${recentLimit ?? 0} последних карт`;

    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
      setCardMessage({
        kind: "error",
        text: "Порог страниц желающих должен быть целым числом от 1 до 100.",
      });
      return;
    }

    if (
      mode === "recent" &&
      (!Number.isInteger(recentLimit) || (recentLimit ?? 0) < 1 || (recentLimit ?? 0) > 100_000)
    ) {
      setCardMessage({
        kind: "error",
        text: "Количество недавних карт должно быть целым числом от 1 до 100000.",
      });
      return;
    }

    if (
      !window.confirm(
        `Проверить ${scopeText} и заблокировать каждый открытый экземпляр с ${threshold} и более страницами желающих? Автоматического разблокирования не будет.`,
      )
    ) {
      return;
    }

    await runCardAction(`start-card-locking-${mode}`, async () => {
      setState(
        await startCardLocking({
          mode,
          threshold,
          recentLimit,
        }),
      );
      setCardMessage({
        kind: "notice",
        text: mode === "all" ? "Проверка всех карт запущена." : "Проверка недавних карт запущена.",
      });
    });
  }

  const runtime = state?.runtime;
  const isBotRunning = Boolean(runtime?.running);
  const currentTradeMode = state ? getTradeMode(state.settings) : getTradeMode(settingsForm);

  return (
    <div className="min-h-screen bg-[#f7f7f4] text-stone-950">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[292px_minmax(0,1fr)]">
        <aside className="border-b border-stone-200 bg-white px-5 py-5 lg:border-b-0 lg:border-r">
          <div className="flex items-start justify-between gap-3 lg:block">
            <div>
              <h1 className="text-xl font-semibold tracking-normal">Обмены Mangabuff</h1>
              <p className="mt-1 text-sm text-stone-500">Локальная панель проверки</p>
            </div>
            <RuntimeBadge runtime={runtime} />
          </div>

          <div className="mt-5 flex flex-wrap gap-2 lg:grid">
            <Button
              disabled={isBotRunning || busyAction === "start-bot"}
              onClick={() =>
                void runAction("start-bot", async () => {
                  setState(await startBot());
                  setMessage(undefined);
                })
              }
            >
              <Play />
              Запустить
            </Button>
            <Button
              disabled={!isBotRunning || busyAction === "stop-bot"}
              onClick={() =>
                void runAction("stop-bot", async () => {
                  setState(await stopBot());
                  setMessage(undefined);
                })
              }
              variant="destructive"
            >
              <Square />
              Остановить
            </Button>
            <Button
              disabled={busyAction === "refresh"}
              onClick={() => void runAction("refresh", refreshState)}
              variant="outline"
            >
              <RefreshCw />
              Обновить
            </Button>
          </div>

          <div className="mt-5 rounded-md border border-stone-200 bg-white p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Режим обменов</h2>
              <ModeBadge mode={currentTradeMode} />
            </div>
            <TradeModeControl
              disabled={busyAction?.startsWith("switch-mode")}
              mode={currentTradeMode}
              onChange={(mode) => void switchTradeMode(mode)}
            />
          </div>

          <section className="mt-5 border-t border-stone-200 pt-5">
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-stone-500" />
              <h2 className="text-sm font-semibold">Авторизация</h2>
            </div>
            <div className="mt-3 grid gap-2">
              <Button
                disabled={busyAction === "start-auth"}
                onClick={() =>
                  void runAction("start-auth", async () => {
                    await startAuth();
                    setAuthMessage({ kind: "notice", text: "Окно входа открыто." });
                    await refreshState();
                  })
                }
                variant="outline"
              >
                Открыть вход
              </Button>
              <Button
                disabled={!state?.auth.manualAuthActive || busyAction === "cancel-auth"}
                onClick={() =>
                  void runAction("cancel-auth", async () => {
                    await cancelAuth();
                    setAuthMessage({ kind: "notice", text: "Окно входа закрыто." });
                    await refreshState();
                  })
                }
                variant="outline"
              >
                <X />
                Закрыть окно
              </Button>
              <Button
                disabled={busyAction === "complete-auth"}
                onClick={() =>
                  void runAction("complete-auth", async () => {
                    const result = await completeAuth();
                    setAuthMessage({
                      kind: result.saved ? "notice" : "error",
                      text: result.saved ? "Сессия сохранена." : "Mangabuff ещё не видит авторизацию.",
                    });
                    await refreshState();
                  })
                }
              >
                Сохранить сессию
              </Button>
              <Button
                disabled={busyAction === "check-auth"}
                onClick={() =>
                  void runAction("check-auth", async () => {
                    const result = await checkAuth();
                    setAuthMessage({
                      kind: result.authorized ? "notice" : "error",
                      text: result.authorized ? "Сессия Mangabuff активна." : "Нужна авторизация Mangabuff.",
                    });
                  })
                }
                variant="secondary"
              >
                Проверить вход
              </Button>
            </div>
            <p className="mt-3 text-sm text-stone-500">{formatAuthStatus(state?.auth)}</p>
            <InlineMessage message={authMessage} />
          </section>
        </aside>

        <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-7">
          <div className="mx-auto grid max-w-7xl gap-5">
            <div className="grid gap-3">
              <div>
                <p className="text-sm text-stone-500">{formatLastPass(runtime?.lastPass, runtime?.lastError)}</p>
                <h2 className="mt-1 text-2xl font-semibold tracking-normal">Контроль обменов</h2>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Metric label="Всего" value={metrics.total} />
                <Metric label="Внимание" value={metrics.problems} tone="bad" />
                <Metric label="Принято" value={metrics.accepted} tone="good" />
                <Metric label="Бот бы принял" value={metrics.safeAccepts} tone="good" />
                <Metric label="Ошибки" value={metrics.errors} tone="warn" />
              </div>
            </div>

            <Tabs className="min-w-0" defaultValue="trades">
              <TabsList>
                <TabsTrigger value="trades">Обмены</TabsTrigger>
                <TabsTrigger value="cards">Карты</TabsTrigger>
                <TabsTrigger value="settings">Настройки</TabsTrigger>
              </TabsList>

              <TabsContent className="min-w-0" value="trades">
                <TradesTable trades={state?.trades ?? []} />
              </TabsContent>

              <TabsContent className="min-w-0" value="cards">
                <CardLockingPanel
                  busyAction={busyAction}
                  message={cardMessage}
                  onChange={setSettingsForm}
                  onStart={(mode) => void beginCardLocking(mode)}
                  onStop={() =>
                    void runCardAction("stop-card-locking", async () => {
                      setState(await stopCardLocking());
                      setCardMessage({ kind: "notice", text: "Остановка проверки запрошена." });
                    })
                  }
                  runtime={state?.cardLocking}
                  settings={settingsForm}
                />
              </TabsContent>

              <TabsContent className="min-w-0" value="settings">
                <section className="rounded-md border border-stone-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 border-b border-stone-200 pb-4 md:flex-row md:items-start md:justify-between">
                    <div>
                      <h3 className="text-base font-semibold">Настройки проверки</h3>
                      <p className="mt-1 text-sm text-stone-500">
                        Telegram-секреты не показываются после сохранения.
                      </p>
                    </div>
                    <Button disabled={busyAction === "save-settings"} onClick={() => void saveSettingsForm()}>
                      <Save />
                      Сохранить
                    </Button>
                  </div>

                  <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <Field label="Максимум страниц желающих">
                      <Input
                        max={100}
                        min={1}
                        onChange={(event) =>
                          setSettingsForm((current) => ({
                            ...current,
                            maxWantedPagesExclusive: event.target.value,
                          }))
                        }
                        step={1}
                        type="number"
                        value={settingsForm.maxWantedPagesExclusive}
                      />
                    </Field>
                    <Field label="Пауза между проходами, мс">
                      <Input
                        max={10_000}
                        min={1_000}
                        onChange={(event) =>
                          setSettingsForm((current) => ({
                            ...current,
                            loopPauseMs: event.target.value,
                          }))
                        }
                        step={500}
                        type="number"
                        value={settingsForm.loopPauseMs}
                      />
                    </Field>
                    <Field label="Режим браузера">
                      <Select
                        onChange={(event) =>
                          setSettingsForm((current) => ({
                            ...current,
                            browserMode: event.target.value as BotSettings["browserMode"],
                          }))
                        }
                        value={settingsForm.browserMode}
                      >
                        <option value="headless">Скрытый</option>
                        <option value="headful">Видимый</option>
                      </Select>
                    </Field>
                    <Field label="Режим обменов">
                      <TradeModeControl
                        mode={getTradeMode(settingsForm)}
                        onChange={(mode) =>
                          setSettingsForm((current) => ({
                            ...current,
                            ...buildTradeModePatch(mode),
                          }))
                        }
                      />
                    </Field>
                    <Field label="Telegram bot token">
                      <Input
                        autoComplete="off"
                        onChange={(event) =>
                          setSettingsForm((current) => ({
                            ...current,
                            telegramBotToken: event.target.value,
                          }))
                        }
                        placeholder="Оставь пустым, чтобы не менять"
                        type="password"
                        value={settingsForm.telegramBotToken}
                      />
                    </Field>
                    <Field label="Telegram chat ID">
                      <Input
                        autoComplete="off"
                        onChange={(event) =>
                          setSettingsForm((current) => ({
                            ...current,
                            telegramChatId: event.target.value,
                          }))
                        }
                        placeholder="Оставь пустым, чтобы не менять"
                        value={settingsForm.telegramChatId}
                      />
                    </Field>
                    <Field label="Telegram">
                      <Input disabled value={formatTelegramStatus(state?.settings)} />
                    </Field>
                    <Field label="Ранги">
                      <Input
                        disabled
                        value={state?.settings.rankRecognitionVerified ? "проверены" : "нужна проверка"}
                      />
                    </Field>
                  </div>

                  <InlineMessage message={message} />
                </section>
              </TabsContent>
            </Tabs>
          </div>
        </main>
      </div>
    </div>
  );
}

function CardLockingPanel({
  busyAction,
  message,
  onChange,
  onStart,
  onStop,
  runtime,
  settings,
}: {
  busyAction?: string;
  message: Message;
  onChange: React.Dispatch<React.SetStateAction<SettingsForm>>;
  onStart: (mode: "all" | "recent") => void;
  onStop: () => void;
  runtime: ApiState["cardLocking"] | undefined;
  settings: SettingsForm;
}) {
  const isRunning = runtime?.status === "running" || runtime?.status === "stopping";
  const progressPercent =
    runtime?.totalCount && runtime.totalCount > 0
      ? Math.min(100, Math.round((runtime.checkedCount / runtime.totalCount) * 100))
      : 0;

  return (
    <div className="grid gap-5">
      <section className="rounded-md border border-stone-200 bg-white p-4 shadow-sm">
        <div className="border-b border-stone-200 pb-4">
          <h3 className="text-base font-semibold">Массовая блокировка карт</h3>
          <p className="mt-1 text-sm text-stone-500">
            Карты только закрываются. Уже закрытые экземпляры не меняются, автоматического открытия нет.
          </p>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border border-stone-200 p-4">
            <div className="flex items-center gap-2">
              <Lock className="size-4 text-stone-500" />
              <h4 className="font-semibold">Все карты</h4>
            </div>
            <p className="mt-1 text-sm text-stone-500">
              Проверить всю коллекцию, все ранги и каждый физический экземпляр.
            </p>
            <div className="mt-4 grid gap-3">
              <Field label="Блокировать при количестве страниц">
                <Input
                  max={100}
                  min={1}
                  onChange={(event) =>
                    onChange((current) => ({
                      ...current,
                      lockAllWantedPagesThreshold: event.target.value,
                    }))
                  }
                  step={1}
                  type="number"
                  value={settings.lockAllWantedPagesThreshold}
                />
              </Field>
              <Button
                disabled={isRunning || busyAction === "start-card-locking-all"}
                onClick={() => onStart("all")}
              >
                <Lock />
                Проверить все карты
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-stone-200 p-4">
            <div className="flex items-center gap-2">
              <History className="size-4 text-stone-500" />
              <h4 className="font-semibold">Недавние карты</h4>
            </div>
            <p className="mt-1 text-sm text-stone-500">
              Идти от самых новых карт по порядку и переходить на следующие страницы до заданного лимита.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Сколько последних карт">
                <Input
                  max={100_000}
                  min={1}
                  onChange={(event) =>
                    onChange((current) => ({
                      ...current,
                      lockRecentCardsLimit: event.target.value,
                    }))
                  }
                  step={1}
                  type="number"
                  value={settings.lockRecentCardsLimit}
                />
              </Field>
              <Field label="Блокировать при страницах">
                <Input
                  max={100}
                  min={1}
                  onChange={(event) =>
                    onChange((current) => ({
                      ...current,
                      lockRecentWantedPagesThreshold: event.target.value,
                    }))
                  }
                  step={1}
                  type="number"
                  value={settings.lockRecentWantedPagesThreshold}
                />
              </Field>
              <Button
                className="sm:col-span-2"
                disabled={isRunning || busyAction === "start-card-locking-recent"}
                onClick={() => onStart("recent")}
              >
                <History />
                Проверить недавние карты
              </Button>
            </div>
          </div>
        </div>

        <InlineMessage message={message} />
      </section>

      <section className="rounded-md border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold">Ход проверки</h3>
              <CardLockingStatusBadge status={runtime?.status ?? "idle"} />
            </div>
            <p className="mt-1 text-sm text-stone-500">{formatCardLockingSummary(runtime)}</p>
          </div>
          <Button
            disabled={!isRunning || runtime?.status === "stopping" || busyAction === "stop-card-locking"}
            onClick={onStop}
            variant="destructive"
          >
            <Square />
            Остановить
          </Button>
        </div>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-stone-100">
          <div
            className="h-full rounded-full bg-emerald-700 transition-[width]"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label="Проверено" value={runtime?.checkedCount ?? 0} />
          <Metric label="Всего" value={runtime?.totalCount ?? 0} />
          <Metric label="Заблокировано" tone="good" value={runtime?.lockedCount ?? 0} />
          <Metric label="Уже закрыто" value={runtime?.alreadyLockedCount ?? 0} />
          <Metric label="Ниже порога" value={runtime?.belowThresholdCount ?? 0} />
          <Metric label="Ошибки" tone="bad" value={runtime?.errorCount ?? 0} />
        </div>

        {runtime?.lastError ? (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {runtime.lastError}
          </div>
        ) : null}

        {runtime?.errors.length ? (
          <div className="mt-4">
            <h4 className="text-sm font-semibold">Отчёт об ошибках</h4>
            <div className="mt-2 max-h-64 overflow-auto rounded-md border border-stone-200">
              {runtime.errors.map((error, index) => (
                <div
                  className="border-b border-stone-100 px-3 py-2 text-sm text-stone-700 last:border-0"
                  key={`${error.instanceId ?? error.cardId ?? "error"}-${index}`}
                >
                  {formatCardLockingError(error)}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function CardLockingStatusBadge({ status }: { status: ApiState["cardLocking"]["status"] }) {
  const labels: Record<ApiState["cardLocking"]["status"], string> = {
    idle: "Не запускалась",
    running: "Работает",
    stopping: "Останавливается",
    completed: "Завершена",
    cancelled: "Остановлена",
    error: "Ошибка",
  };
  const variants: Record<ApiState["cardLocking"]["status"], BadgeProps["variant"]> = {
    idle: "default",
    running: "good",
    stopping: "warn",
    completed: "good",
    cancelled: "warn",
    error: "bad",
  };

  return <Badge variant={variants[status]}>{labels[status]}</Badge>;
}

function TradesTable({ trades }: { trades: TradeRecord[] }) {
  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-md border border-stone-200 bg-white shadow-sm">
      <div className="table-scroll w-full max-w-full overflow-x-auto">
        <table className="w-full min-w-[1060px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50 text-left text-xs font-semibold uppercase text-stone-500">
              <th className="px-3 py-3">Обмен</th>
              <th className="px-3 py-3">Статус</th>
              <th className="px-3 py-3">Пользователь</th>
              <th className="px-3 py-3">Забирают</th>
              <th className="px-3 py-3">Предлагают</th>
              <th className="px-3 py-3">Страницы желающих</th>
              <th className="px-3 py-3">Ранги</th>
              <th className="px-3 py-3">Причина</th>
              <th className="px-3 py-3">Обновлён</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-stone-500" colSpan={9}>
                  История обменов пуста.
                </td>
              </tr>
            ) : (
              trades.map((trade) => <TradeRow key={trade.tradeId} trade={trade} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TradeRow({ trade }: { trade: TradeRecord }) {
  return (
    <tr className="border-b border-stone-100 last:border-0">
      <td className="whitespace-nowrap px-3 py-3 align-top">
        <a
          className="inline-flex items-center gap-1 font-medium text-emerald-800 hover:underline"
          href={trade.tradeUrl}
          rel="noreferrer"
          target="_blank"
        >
          #{trade.tradeId}
          <ExternalLink className="size-3" />
        </a>
      </td>
      <td className="px-3 py-3 align-top">
        <StatusBadge status={trade.status} />
      </td>
      <td className="px-3 py-3 align-top text-stone-700">{trade.senderName || "не удалось определить"}</td>
      <td className="max-w-[260px] px-3 py-3 align-top text-stone-700">{formatCards(trade.requestedCards)}</td>
      <td className="max-w-[260px] px-3 py-3 align-top text-stone-700">{formatCards(trade.offeredCards)}</td>
      <td className="whitespace-nowrap px-3 py-3 align-top text-stone-700">
        {trade.wantedPagesCount ?? "не проверялось"}
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-top text-stone-700">
        {formatRankRule(trade.rankRuleResult)}
      </td>
      <td className="max-w-[360px] px-3 py-3 align-top text-stone-700">{trade.reason || "не указана"}</td>
      <td className="whitespace-nowrap px-3 py-3 align-top text-stone-700">{formatDate(trade.updatedAt)}</td>
    </tr>
  );
}

function RuntimeBadge({ runtime }: { runtime: ApiState["runtime"] | undefined }) {
  if (runtime?.running) {
    return (
      <Badge variant={runtime.stopping ? "warn" : "good"}>
        <ShieldCheck className="mr-1 size-3" />
        {runtime.stopping ? "Остановка" : "Работает"}
      </Badge>
    );
  }

  if (runtime?.lastError) {
    return (
      <Badge variant="bad">
        <CircleAlert className="mr-1 size-3" />
        Ошибка
      </Badge>
    );
  }

  return <Badge>Остановлен</Badge>;
}

function ModeBadge({ mode }: { mode: TradeMode }) {
  if (mode === "auto") {
    return (
      <Badge variant="warn">
        <MousePointerClick className="mr-1 size-3" />
        Принимает
      </Badge>
    );
  }

  return (
    <Badge variant="good">
      <ShieldCheck className="mr-1 size-3" />
      Анализ
    </Badge>
  );
}

function TradeModeControl({
  disabled = false,
  mode,
  onChange,
}: {
  disabled?: boolean;
  mode: TradeMode;
  onChange: (mode: TradeMode) => void;
}) {
  return (
    <div className="grid gap-2">
      <Button
        aria-pressed={mode === "safe"}
        className={mode === "safe" ? "border-emerald-700 bg-emerald-700 hover:bg-emerald-800" : undefined}
        disabled={disabled}
        onClick={() => onChange("safe")}
        type="button"
        variant={mode === "safe" ? "default" : "outline"}
      >
        <ShieldCheck />
        Только анализ
      </Button>
      <Button
        aria-pressed={mode === "auto"}
        disabled={disabled}
        onClick={() => onChange("auto")}
        type="button"
        variant={mode === "auto" ? "destructive" : "outline"}
      >
        <MousePointerClick />
        Принимать
      </Button>
    </div>
  );
}

function StatusBadge({ status }: { status: TradeStatus }) {
  const variantByStatus: Record<TradeStatus, BadgeProps["variant"]> = {
    новое: "default",
    ошибка_проверки: "warn",
    требует_ручной_проверки: "bad",
    брошен_по_правилам: "bad",
    принят: "good",
    бот_бы_принял: "good",
    неактуален: "default",
  };

  return <Badge variant={variantByStatus[status]}>{status}</Badge>;
}

function Metric({
  label,
  tone = "default",
  value,
}: {
  label: string;
  tone?: "default" | "good" | "warn" | "bad";
  value: number;
}) {
  const toneClassName = {
    bad: "border-red-200 bg-red-50 text-red-900",
    default: "border-stone-200 bg-white text-stone-900",
    good: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
  }[tone];

  return (
    <div className={`min-w-0 rounded-md border px-3 py-2 shadow-sm ${toneClassName}`}>
      <div className="text-xs text-stone-500">{label}</div>
      <div className="text-xl font-semibold leading-tight">{value}</div>
    </div>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function InlineMessage({ message }: { message: Message }) {
  if (!message) {
    return null;
  }

  const className =
    message.kind === "error"
      ? "mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
      : "mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800";

  return <div className={className}>{message.text}</div>;
}

function formatAuthStatus(auth: ApiState["auth"] | undefined): string {
  if (!auth) {
    return "Проверка авторизации ещё не выполнялась.";
  }

  if (auth.authorized) {
    return auth.lastSuccessAt
      ? `Mangabuff авторизован. Последний успех: ${formatDate(auth.lastSuccessAt)}.`
      : "Mangabuff авторизован.";
  }

  if (auth.recoveryScheduledAt) {
    return `Mangabuff ждёт повторную авторизацию. Следующая попытка: ${formatDate(auth.recoveryScheduledAt)}.`;
  }

  if (auth.lastFailureReason) {
    return `Mangabuff требует повторной авторизации: ${auth.lastFailureReason}.`;
  }

  return "Mangabuff требует повторной авторизации.";
}

function createEmptySettingsForm(): SettingsForm {
  return {
    telegramBotToken: "",
    telegramChatId: "",
    maxWantedPagesExclusive: "5",
    lockAllWantedPagesThreshold: "5",
    lockRecentWantedPagesThreshold: "5",
    lockRecentCardsLimit: "100",
    loopPauseMs: "5000",
    browserMode: "headless",
    safeMode: true,
    autoAcceptEnabled: false,
  };
}

function mergeSettingsIntoForm(current: SettingsForm, settings: ApiSettings): SettingsForm {
  return {
    ...current,
    maxWantedPagesExclusive: String(settings.maxWantedPagesExclusive),
    lockAllWantedPagesThreshold: String(settings.lockAllWantedPagesThreshold),
    lockRecentWantedPagesThreshold: String(settings.lockRecentWantedPagesThreshold),
    lockRecentCardsLimit: String(settings.lockRecentCardsLimit),
    loopPauseMs: String(settings.loopPauseMs),
    browserMode: settings.browserMode,
    safeMode: settings.safeMode,
    autoAcceptEnabled: settings.autoAcceptEnabled,
  };
}

function getTradeMode(settings: Pick<ApiSettings | SettingsForm, "autoAcceptEnabled" | "safeMode">): TradeMode {
  return !settings.safeMode && settings.autoAcceptEnabled ? "auto" : "safe";
}

function buildTradeModePatch(mode: TradeMode): Pick<SettingsForm, "autoAcceptEnabled" | "safeMode"> {
  return mode === "auto"
    ? { autoAcceptEnabled: true, safeMode: false }
    : { autoAcceptEnabled: false, safeMode: true };
}

function buildMetrics(trades: TradeRecord[]) {
  return {
    total: trades.length,
    problems: trades.filter((trade) =>
      trade.status === "требует_ручной_проверки" || trade.status === "брошен_по_правилам",
    ).length,
    accepted: trades.filter((trade) => trade.status === "принят").length,
    safeAccepts: trades.filter((trade) => trade.status === "бот_бы_принял").length,
    errors: trades.filter((trade) => trade.status === "ошибка_проверки").length,
  };
}

function formatLastPass(pass: ApiRuntimePass | undefined, lastError: string | undefined): string {
  if (pass?.status === "ok") {
    return `Последний проход #${pass.passNumber}: видимых ${pass.visibleTrades.length}, принято ${pass.acceptedCount}, ручная проверка ${pass.manualReviewCount}, ошибок ${pass.checkErrorCount}.`;
  }

  if (pass?.status === "temporary_error") {
    return `Последний проход: временная ошибка. ${pass.reason}`;
  }

  if (pass?.status === "auth_required") {
    return "Последний проход: нужна повторная авторизация Mangabuff.";
  }

  if (lastError) {
    return lastError;
  }

  return "Проходов ещё не было.";
}

function formatCards(cards: TradeCard[]): string {
  if (!cards || cards.length === 0) {
    return "не удалось определить";
  }

  return cards
    .map((card) => {
      const title = card.title || "карта";
      const rank = card.rank ? `, ранг ${card.rank}` : "";

      return `${title} #${card.cardId}${rank}`;
    })
    .join(", ");
}

function formatRankRule(value: TradeRecord["rankRuleResult"]): string {
  if (value === "выполнено") {
    return "выполнено";
  }

  if (value === "не_выполнено") {
    return "не выполнено";
  }

  return "не проверялось";
}

function formatDate(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU");
}

function formatTelegramStatus(settings: ApiSettings | undefined): string {
  if (!settings?.telegramConfigured) {
    return "не настроен";
  }

  return settings.telegramChatId ? `настроен (${settings.telegramChatId})` : "настроен";
}

function formatCardLockingSummary(runtime: ApiState["cardLocking"] | undefined): string {
  if (!runtime || runtime.status === "idle") {
    return "Проверки карт ещё не запускались.";
  }

  const scope =
    runtime.mode === "recent"
      ? `${runtime.requestedLimit ?? 0} недавних карт`
      : "вся коллекция";
  const threshold = runtime.threshold ?? 0;
  const progress = runtime.totalCount
    ? `${runtime.checkedCount} из ${runtime.totalCount}`
    : String(runtime.checkedCount);

  if (runtime.status === "running" || runtime.status === "stopping") {
    const current =
      runtime.currentPage || runtime.currentCardId
        ? ` Страница ${runtime.currentPage ?? "—"}, карта #${runtime.currentCardId ?? "—"}.`
        : "";

    return `${scope}, порог ${threshold}+: проверено ${progress}.${current}`;
  }

  const finishedAt = runtime.finishedAt ? ` Завершено: ${formatDate(runtime.finishedAt)}.` : "";
  return `${scope}, порог ${threshold}+: проверено ${progress}, заблокировано ${runtime.lockedCount}, ошибок ${runtime.errorCount}.${finishedAt}`;
}

function formatCardLockingError(error: ApiState["cardLocking"]["errors"][number]): string {
  const context = [
    error.page ? `страница ${error.page}` : undefined,
    error.cardId ? `карта #${error.cardId}` : undefined,
    error.instanceId ? `экземпляр #${error.instanceId}` : undefined,
  ].filter(Boolean);

  return `${context.length > 0 ? `${context.join(", ")}: ` : ""}${error.reason}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
