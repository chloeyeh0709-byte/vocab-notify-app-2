// WordVault — send-due-notifications
//
// Invoked once a minute by a pg_cron job (see README.md step 6). It:
//   1. Looks for word_schedule rows that are due and haven't been pushed yet
//   2. Groups them by user (one combined notification beats a notification storm)
//   3. Sends a real Web Push message (VAPID) to each user's saved subscription
//   4. Stamps `last_notified_for` so the same due time is never re-sent, and
//      drops subscriptions the browser has revoked (HTTP 404/410)
//
// Required secrets (set with `supabase secrets set ...`, see README step 5):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  → provided automatically by Supabase
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY      → from `npx web-push generate-vapid-keys`
//   VAPID_SUBJECT                            → "mailto:you@example.com"
//   CRON_SECRET                              → any random string you choose;
//                                              must match the cron job's Authorization header

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:wordvault@example.com';
const CRON_SECRET = Deno.env.get('CRON_SECRET');

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

interface ScheduleRow {
  id: string;
  user_id: string;
  english: string;
  chinese: string;
  stage: number;
  next_review: string;
  last_notified_for: string | null;
}

// Multiple words due at once: name them (capped, so the notification stays
// readable) instead of just printing a count.
const MAX_NAMES_IN_BODY = 5;
function formatDueBody(words: ScheduleRow[]): string {
  const names = words.slice(0, MAX_NAMES_IN_BODY).map((w) => w.english).join('、');
  return words.length > MAX_NAMES_IN_BODY ? `${names}…等 ${words.length} 個單字` : names;
}

Deno.serve(async (req) => {
  if (CRON_SECRET) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return new Response('unauthorized', { status: 401 });
    }
  }

  const now = new Date();

  const { data: rows, error } = await supabase
    .from('word_schedule')
    .select('id, user_id, english, chinese, stage, next_review, last_notified_for')
    .not('next_review', 'is', null)
    .lte('next_review', now.toISOString());

  if (error) {
    console.error('query failed:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  // A row is "due and unsent" only if its current next_review hasn't been
  // notified about yet — comparing two columns isn't expressible as a single
  // PostgREST filter, so we do it here once the (small) candidate set is in hand.
  const due = (rows ?? []).filter((r: ScheduleRow) => {
    if (!r.next_review) return false;
    if (!r.last_notified_for) return true;
    return new Date(r.last_notified_for).getTime() !== new Date(r.next_review).getTime();
  });

  if (due.length === 0) {
    return Response.json({ dueWords: 0, usersNotified: 0 });
  }

  const byUser = new Map<string, ScheduleRow[]>();
  for (const row of due) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }

  let usersNotified = 0;
  let removedSubscriptions = 0;

  // Stamp each row with ITS OWN next_review value — not "now" — so the
  // due-and-unsent check above (which compares last_notified_for to
  // next_review) recognizes it as handled and stops re-notifying every
  // minute. A fresh notification only fires again once next_review actually
  // changes, e.g. the word is reviewed and advances to its next stage.
  const stamp = (rows: ScheduleRow[]) =>
    Promise.all(rows.map((r) =>
      supabase.from('word_schedule').update({ last_notified_for: r.next_review }).eq('id', r.id)
    ));

  for (const [userId, words] of byUser) {
    const { data: subRow } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', userId)
      .maybeSingle();

    if (!subRow?.subscription) {
      // Nobody to notify (push never enabled, or subscription already gone) —
      // stamp anyway so this word doesn't get re-evaluated every minute forever.
      await stamp(words);
      continue;
    }

    const payload = words.length === 1
      ? {
          title: '📚 該複習了',
          body: `${words[0].english} — ${words[0].chinese}`,
          data: { type: 'review_word', wordId: words[0].id },
        }
      : {
          title: '📚 該複習了',
          body: formatDueBody(words),
          data: { type: 'review_due' },
        };

    try {
      await webpush.sendNotification(subRow.subscription, JSON.stringify(payload));
      usersNotified++;
      await stamp(words);
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      console.error(`push failed for user ${userId} (status ${statusCode}):`, err);
      if (statusCode === 404 || statusCode === 410) {
        // Browser revoked this subscription — remove it and stamp so we stop retrying.
        await supabase.from('push_subscriptions').delete().eq('user_id', userId);
        removedSubscriptions++;
        await stamp(words);
      }
      // Other errors (e.g. transient network issues): leave unstamped so the
      // next run retries automatically.
    }
  }

  return Response.json({ dueWords: due.length, usersNotified, removedSubscriptions });
});
