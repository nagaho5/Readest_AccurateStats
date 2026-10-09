import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookProgress } from '@/types/book';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  getBookData: vi.fn(() => null as unknown),
  progress: null as BookProgress | null,
  playbackState: null as 'playing' | 'paused' | null,
  isDesktopApp: false,
  isFocused: vi.fn().mockResolvedValue(true),
  focusListener: null as null | ((event: { payload: boolean }) => void),
  db: {
    upsertBook: vi.fn(),
    insertPageEvent: vi.fn(),
    recomputeBookTotals: vi.fn(),
  },
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { isDesktopApp: mocks.isDesktopApp } }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFocused: mocks.isFocused,
    onFocusChanged: (listener: (event: { payload: boolean }) => void) => {
      mocks.focusListener = listener;
      return Promise.resolve(() => {
        mocks.focusListener = null;
      });
    },
  }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => mocks.progress,
  getBookProgress: () => mocks.progress,
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => mocks.getBookData,
}));
vi.mock('@/services/statistics/statisticsDb', () => ({
  StatisticsDb: { open: mocks.open },
}));
vi.mock('@/services/statistics/statsSync', () => ({
  pushStats: vi.fn(),
  pullStats: vi.fn(),
}));
vi.mock('@/services/sync/syncCategories', () => ({ isSyncCategoryEnabled: () => false }));
vi.mock('@/libs/sync', () => ({ SyncClient: class {} }));
vi.mock('@/services/tts/TTSSessionManager', () => ({
  ttsSessionManager: {
    getPlaybackState: () => mocks.playbackState,
    getActiveSession: () => (mocks.playbackState ? { bookHash: 'hash1' } : null),
  },
  getBookHashFromKey: (key: string) => key.split('-')[0],
}));

import { eventDispatcher } from '@/utils/event';
import ReadingStatsTracker from '@/app/reader/components/ReadingStatsTracker';

describe('ReadingStatsTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('contains a database-open failure instead of leaking an unhandled rejection', async () => {
    const error = new Error('synthetic database open failure');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.open.mockRejectedValueOnce(error);

    render(<ReadingStatsTracker bookKey='book-1' />);

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith('[stats] background operation failed:', error);
    });
  });
});

describe('ReadingStatsTracker while TTS plays', () => {
  const BOOK_KEY = 'hash1-view1';

  const setPage = (current: number) => {
    mocks.progress = {
      pageinfo: { current, next: current + 1, total: 100 },
    } as unknown as BookProgress;
  };

  const mount = () => render(<ReadingStatsTracker bookKey={BOOK_KEY} />);

  const settle = async (ms = 0) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  const emitPlaybackState = async (state: string, bookKey = BOOK_KEY) => {
    await act(async () => {
      await eventDispatcher.dispatch('tts-playback-state', { bookKey, state });
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.open.mockResolvedValue(mocks.db);
    mocks.db.upsertBook.mockResolvedValue(1);
    mocks.db.insertPageEvent.mockResolvedValue(undefined);
    mocks.db.recomputeBookTotals.mockResolvedValue(undefined);
    mocks.getBookData.mockReturnValue({
      book: { hash: 'md5-1', title: 'Book', author: 'Author' },
    } as unknown as null);
    mocks.playbackState = null;
    setPage(0);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records page dwell normally when TTS is idle', async () => {
    const { rerender } = mount();
    await settle();

    await settle(30_000);
    setPage(1);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    expect(mocks.db.insertPageEvent).toHaveBeenCalled();
  });

  it('stops recording page dwell while TTS is playing', async () => {
    const { rerender } = mount();
    await settle();
    await emitPlaybackState('playing');

    await settle(30_000);
    setPage(1);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle(30_000);
    setPage(2);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    expect(mocks.db.insertPageEvent).not.toHaveBeenCalled();
  });

  it('resumes recording once TTS stops', async () => {
    const { rerender } = mount();
    await settle();
    await emitPlaybackState('playing');
    await settle(30_000);
    await emitPlaybackState('stopped');

    await settle(30_000);
    setPage(1);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    expect(mocks.db.insertPageEvent).toHaveBeenCalled();
  });

  it('starts dormant when mounted into an already-playing session', async () => {
    mocks.playbackState = 'playing';
    const { rerender } = mount();
    await settle();

    await settle(30_000);
    setPage(1);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    expect(mocks.db.insertPageEvent).not.toHaveBeenCalled();
  });

  it('keeps recording when another book is the one being read aloud', async () => {
    const { rerender } = mount();
    await settle();
    await emitPlaybackState('playing', 'hash2-view1');

    await settle(30_000);
    setPage(1);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    expect(mocks.db.insertPageEvent).toHaveBeenCalled();
  });
});

describe('ReadingStatsTracker desktop focus accounting', () => {
  const BOOK_KEY = 'hash1-view1';

  const setPage = (current: number) => {
    mocks.progress = {
      pageinfo: { current, next: current + 1, total: 100 },
    } as unknown as BookProgress;
  };

  const settle = async (ms = 0) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  const focus = async (focused: boolean) => {
    expect(mocks.focusListener).not.toBeNull();
    await act(async () => {
      mocks.focusListener?.({ payload: focused });
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    vi.clearAllMocks();
    mocks.isDesktopApp = true;
    mocks.focusListener = null;
    mocks.isFocused.mockResolvedValue(true);
    mocks.open.mockResolvedValue(mocks.db);
    mocks.db.upsertBook.mockResolvedValue(1);
    mocks.db.insertPageEvent.mockResolvedValue(undefined);
    mocks.db.recomputeBookTotals.mockResolvedValue(undefined);
    mocks.getBookData.mockReturnValue({
      book: { hash: 'md5-1', title: 'Book', author: 'Author' },
    } as unknown as null);
    mocks.playbackState = null;
    setPage(0);
  });

  afterEach(() => {
    cleanup();
    mocks.isDesktopApp = false;
    mocks.focusListener = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('excludes unfocused time and resumes on the same page without a turn', async () => {
    const { rerender } = render(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    await settle(20_000);
    await focus(false);
    await settle(60_000);
    await focus(true);
    await settle(30_000);
    setPage(1);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    const events = mocks.db.insertPageEvent.mock.calls.map((call) => call[1]);
    expect(events.map((event) => event.duration)).toEqual([20, 30]);
    expect(events.map((event) => event.page)).toEqual([1, 1]);
  });

  it('does not start an offscreen dwell when progress changes in the background', async () => {
    const { rerender } = render(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    await settle(15_000);
    await focus(false);
    await settle(40_000);
    setPage(1);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle(25_000);
    await focus(true);
    await settle(25_000);
    setPage(2);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    const events = mocks.db.insertPageEvent.mock.calls.map((call) => call[1]);
    expect(events.map((event) => event.duration)).toEqual([15, 25]);
    expect(events.map((event) => event.page)).toEqual([1, 2]);
  });

  it('starts paused when the desktop window is already unfocused', async () => {
    mocks.isFocused.mockResolvedValue(false);
    const { rerender } = render(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();
    await settle(40_000);
    expect(mocks.db.insertPageEvent).not.toHaveBeenCalled();

    await focus(true);
    await settle(25_000);
    setPage(1);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    const events = mocks.db.insertPageEvent.mock.calls.map((call) => call[1]);
    expect(events.map((event) => event.duration)).toEqual([25]);
  });

  it('does not resume manual reading while TTS is playing', async () => {
    const { rerender } = render(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();
    await settle(20_000);
    await focus(false);
    await act(async () => {
      await eventDispatcher.dispatch('tts-playback-state', { bookKey: BOOK_KEY, state: 'playing' });
    });
    await focus(true);
    await settle(30_000);
    setPage(1);
    rerender(<ReadingStatsTracker bookKey={BOOK_KEY} />);
    await settle();

    const events = mocks.db.insertPageEvent.mock.calls.map((call) => call[1]);
    expect(events.map((event) => event.duration)).toEqual([20]);
  });
});
