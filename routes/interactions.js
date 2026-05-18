const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

/**
 * GET /interactions/issues
 * Returns aggregated issue categories for the issues dashboard.
 * Includes current period counts and previous period for % change.
 *
 * Query params:
 *   - brand_id: UUID (required)
 *   - days: number (optional, default 30) — period length in days
 */
router.get('/issues', async (req, res) => {
  try {
    const { brand_id, days = 30 } = req.query;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    const periodDays = parseInt(days, 10);
    const now = new Date();
    const currentStart = new Date(now.getTime() - periodDays * 86400000).toISOString();
    const prevStart = new Date(now.getTime() - periodDays * 2 * 86400000).toISOString();

    // Current period issues
    const { data: current, error: curErr } = await supabase
      .from('interactions')
      .select('issue_category')
      .eq('brand_id', brand_id)
      .not('issue_category', 'is', null)
      .not('analyzed_at', 'is', null)
      .gte('created_at', currentStart);

    if (curErr) {
      return res.status(500).json({ error: curErr.message });
    }

    // Previous period issues (for % change)
    const { data: previous, error: prevErr } = await supabase
      .from('interactions')
      .select('issue_category')
      .eq('brand_id', brand_id)
      .not('issue_category', 'is', null)
      .not('analyzed_at', 'is', null)
      .gte('created_at', prevStart)
      .lt('created_at', currentStart);

    if (prevErr) {
      return res.status(500).json({ error: prevErr.message });
    }

    // Aggregate current
    const currentCounts = {};
    for (const row of current) {
      currentCounts[row.issue_category] = (currentCounts[row.issue_category] || 0) + 1;
    }

    // Aggregate previous
    const prevCounts = {};
    for (const row of previous) {
      prevCounts[row.issue_category] = (prevCounts[row.issue_category] || 0) + 1;
    }

    // Build response with % change
    const issues = Object.entries(currentCounts)
      .map(([category, count]) => {
        const prevCount = prevCounts[category] || 0;
        const change = prevCount === 0
          ? (count > 0 ? 100 : 0)
          : Math.round(((count - prevCount) / prevCount) * 100);

        return { category, count, previous_count: prevCount, change_percent: change };
      })
      .sort((a, b) => b.count - a.count);

    res.json({ issues, period_days: periodDays });
  } catch (err) {
    console.error('interactions/issues error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /interactions/issues/:category
 * Returns all interactions for a specific issue category (for the popup).
 * Each interaction includes conversation_id and message IDs for deep-linking.
 *
 * Query params:
 *   - brand_id: UUID (required)
 *   - days: number (optional, default 30)
 *   - limit: number (optional, default 50)
 */
router.get('/issues/:category', async (req, res) => {
  try {
    const { brand_id, days = 30, limit = 50 } = req.query;
    const { category } = req.params;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    const periodStart = new Date(Date.now() - parseInt(days, 10) * 86400000).toISOString();

    const { data, error } = await supabase
      .from('interactions')
      .select(`
        id,
        conversation_id,
        customer_id,
        customer_username,
        started_at,
        ended_at,
        message_count,
        sentiment,
        sentiment_score,
        issue_category,
        issue_summary,
        resolution_status,
        was_escalated,
        first_message_id,
        last_message_id
      `)
      .eq('brand_id', brand_id)
      .eq('issue_category', category)
      .not('analyzed_at', 'is', null)
      .gte('created_at', periodStart)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit, 10));

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ interactions: data, category, count: data.length });
  } catch (err) {
    console.error('interactions/issues/:category error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /interactions/sentiment
 * Returns sentiment distribution for the sentiment analysis widget.
 *
 * Query params:
 *   - brand_id: UUID (required)
 *   - days: number (optional, default 30)
 */
router.get('/sentiment', async (req, res) => {
  try {
    const { brand_id, days = 30 } = req.query;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    const periodStart = new Date(Date.now() - parseInt(days, 10) * 86400000).toISOString();

    const { data, error } = await supabase
      .from('interactions')
      .select('sentiment')
      .eq('brand_id', brand_id)
      .not('sentiment', 'is', null)
      .not('analyzed_at', 'is', null)
      .gte('created_at', periodStart);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Count by sentiment
    const counts = {};
    for (const row of data) {
      counts[row.sentiment] = (counts[row.sentiment] || 0) + 1;
    }

    const total = data.length;
    const distribution = Object.entries(counts)
      .map(([sentiment, count]) => ({
        sentiment,
        count,
        percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ distribution, total, period_days: parseInt(days, 10) });
  } catch (err) {
    console.error('interactions/sentiment error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /interactions/reports
 * Returns aggregated data for the reports dashboard:
 *   - total DMs this period (+ % change)
 *   - resolution rate (+ change)
 *   - average response time (+ change)
 *   - escalation count (+ change)
 *   - monthly volume (last 6 months)
 *
 * Query params:
 *   - brand_id: UUID (required)
 *   - days: number (optional, default 30)
 */
router.get('/reports', async (req, res) => {
  try {
    const { brand_id, days = 30 } = req.query;

    if (!brand_id) {
      return res.status(400).json({ error: 'brand_id is required' });
    }

    const periodDays = parseInt(days, 10);
    const now = new Date();
    const currentStart = new Date(now.getTime() - periodDays * 86400000).toISOString();
    const prevStart = new Date(now.getTime() - periodDays * 2 * 86400000).toISOString();

    // Total DMs — current and previous period
    const [curMsgs, prevMsgs] = await Promise.all([
      supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id.brand_id', brand_id)
        .gte('created_at', currentStart),
      supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id.brand_id', brand_id)
        .gte('created_at', prevStart)
        .lt('created_at', currentStart),
    ]);

    // Since messages doesn't have brand_id directly, query via interactions
    const [curInteractions, prevInteractions] = await Promise.all([
      supabase
        .from('interactions')
        .select('resolution_status, response_time_avg_ms, was_escalated, message_count')
        .eq('brand_id', brand_id)
        .not('analyzed_at', 'is', null)
        .gte('created_at', currentStart),
      supabase
        .from('interactions')
        .select('resolution_status, response_time_avg_ms, was_escalated, message_count')
        .eq('brand_id', brand_id)
        .not('analyzed_at', 'is', null)
        .gte('created_at', prevStart)
        .lt('created_at', currentStart),
    ]);

    const curData = curInteractions.data || [];
    const prevData = prevInteractions.data || [];

    // Total DMs (sum of message_count from interactions)
    const curTotalDMs = curData.reduce((sum, i) => sum + (i.message_count || 0), 0);
    const prevTotalDMs = prevData.reduce((sum, i) => sum + (i.message_count || 0), 0);
    const dmChange = prevTotalDMs === 0
      ? (curTotalDMs > 0 ? 100 : 0)
      : Math.round(((curTotalDMs - prevTotalDMs) / prevTotalDMs) * 100);

    // Resolution rate
    const curResolved = curData.filter(i => i.resolution_status === 'resolved').length;
    const curResolutionRate = curData.length > 0 ? Math.round((curResolved / curData.length) * 100) : 0;
    const prevResolved = prevData.filter(i => i.resolution_status === 'resolved').length;
    const prevResolutionRate = prevData.length > 0 ? Math.round((prevResolved / prevData.length) * 100) : 0;
    const resolutionChange = curResolutionRate - prevResolutionRate;

    // Average response time
    const curResponseTimes = curData.filter(i => i.response_time_avg_ms != null).map(i => i.response_time_avg_ms);
    const curAvgResponse = curResponseTimes.length > 0
      ? Math.round(curResponseTimes.reduce((a, b) => a + b, 0) / curResponseTimes.length)
      : 0;
    const prevResponseTimes = prevData.filter(i => i.response_time_avg_ms != null).map(i => i.response_time_avg_ms);
    const prevAvgResponse = prevResponseTimes.length > 0
      ? Math.round(prevResponseTimes.reduce((a, b) => a + b, 0) / prevResponseTimes.length)
      : 0;
    const responseChange = curAvgResponse - prevAvgResponse;

    // Escalations
    const curEscalations = curData.filter(i => i.was_escalated).length;
    const prevEscalations = prevData.filter(i => i.was_escalated).length;
    const escalationChange = curEscalations - prevEscalations;

    // Monthly volume (last 6 months)
    const sixMonthsAgo = new Date(now.getTime() - 180 * 86400000).toISOString();
    const { data: monthlyData } = await supabase
      .from('interactions')
      .select('created_at, message_count')
      .eq('brand_id', brand_id)
      .gte('created_at', sixMonthsAgo);

    const monthlyVolume = {};
    for (const row of (monthlyData || [])) {
      const month = new Date(row.created_at).toISOString().slice(0, 7); // YYYY-MM
      monthlyVolume[month] = (monthlyVolume[month] || 0) + (row.message_count || 0);
    }

    // Sort months chronologically
    const sortedMonths = Object.entries(monthlyVolume)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, count]) => ({ month, count }));

    res.json({
      total_dms: { value: curTotalDMs, change: dmChange },
      resolution_rate: { value: curResolutionRate, change: resolutionChange },
      avg_response_ms: { value: curAvgResponse, change: responseChange },
      escalations: { value: curEscalations, change: escalationChange },
      monthly_volume: sortedMonths,
      period_days: periodDays,
    });
  } catch (err) {
    console.error('interactions/reports error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
