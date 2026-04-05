require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────
// CACHE LAYER — everything lives here, read once
// ─────────────────────────────────────────────────────
let todaysGames       = [];
let playerStatsCache  = {};   // keyed by player name
let rosterCache       = {};   // keyed by ESPN team abbreviation
let lastRosterFetch   = {};   // timestamps per team
let lineupCache       = null;
let lastLineupFetch   = null;
let nbaStatsCache     = null; // loaded once from disk, cleared at midnight
let lastStatsDiskRead = 0;

const BALLDONTLIE   = 'https://api.balldontlie.io/v1';
const ODDS_BASE     = 'https://api.the-odds-api.com/v4';
const RAPIDAPI_HOST = 'tank01-fantasy-stats.p.rapidapi.com';
const ESPN_BASE     = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';

// ESPN team abbreviation map — covers all 30 teams + common aliases
const ESPN_TEAM_MAP = {
  'atlanta hawks': 'atl', 'hawks': 'atl',
  'boston celtics': 'bos', 'celtics': 'bos',
  'brooklyn nets': 'bkn', 'nets': 'bkn',
  'charlotte hornets': 'cha', 'hornets': 'cha',
  'chicago bulls': 'chi', 'bulls': 'chi',
  'cleveland cavaliers': 'cle', 'cavaliers': 'cle', 'cavs': 'cle',
  'dallas mavericks': 'dal', 'mavericks': 'dal', 'mavs': 'dal',
  'denver nuggets': 'den', 'nuggets': 'den',
  'detroit pistons': 'det', 'pistons': 'det',
  'golden state warriors': 'gs', 'warriors': 'gs', 'golden state': 'gs',
  'houston rockets': 'hou', 'rockets': 'hou',
  'indiana pacers': 'ind', 'pacers': 'ind',
  'la clippers': 'lac', 'clippers': 'lac', 'los angeles clippers': 'lac',
  'los angeles lakers': 'lal', 'lakers': 'lal', 'la lakers': 'lal',
  'memphis grizzlies': 'mem', 'grizzlies': 'mem',
  'miami heat': 'mia', 'heat': 'mia',
  'milwaukee bucks': 'mil', 'bucks': 'mil',
  'minnesota timberwolves': 'min', 'timberwolves': 'min', 'wolves': 'min',
  'new orleans pelicans': 'no', 'pelicans': 'no', 'new orleans': 'no',
  'new york knicks': 'ny', 'knicks': 'ny', 'new york': 'ny',
  'oklahoma city thunder': 'okc', 'thunder': 'okc', 'oklahoma city': 'okc',
  'orlando magic': 'orl', 'magic': 'orl',
  'philadelphia 76ers': 'phi', '76ers': 'phi', 'sixers': 'phi',
  'phoenix suns': 'phx', 'suns': 'phx',
  'portland trail blazers': 'por', 'trail blazers': 'por', 'blazers': 'por',
  'sacramento kings': 'sac', 'kings': 'sac',
  'san antonio spurs': 'sa', 'spurs': 'sa', 'san antonio': 'sa',
  'toronto raptors': 'tor', 'raptors': 'tor',
  'utah jazz': 'utah', 'jazz': 'utah',
  'washington wizards': 'wsh', 'wizards': 'wsh', 'washington': 'wsh',
};

function resolveESPNTeam(teamName) {
  const lower = teamName.toLowerCase().trim();
  return ESPN_TEAM_MAP[lower] || null;
}

// ─────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────
function getToday()        { return new Date().toISOString().split('T')[0]; }
function getTodayCompact() { return getToday().replace(/-/g, ''); }

function calcAvg(games, key) {
  const vals = games.map(g => parseFloat(g[key]) || 0).filter(v => v >= 0);
  if (!vals.length) return '0.0';
  return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
}

function calcStdDev(games, key) {
  const vals = games.map(g => parseFloat(g[key]) || 0);
  if (!vals.length) return '0.0';
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / vals.length).toFixed(1);
}

// Full-name fuzzy match — avoids wrong-player errors from last-name-only search
function fuzzyMatchPlayer(list, fullName) {
  const lower = fullName.toLowerCase();
  const parts = lower.split(' ');
  const first = parts[0];
  const last  = parts[parts.length - 1];
  // Exact full name match first
  let match = list.find(p => (p.PLAYER_NAME || p.name || '').toLowerCase() === lower);
  // Then first + last
  if (!match) match = list.find(p => {
    const n = (p.PLAYER_NAME || p.name || '').toLowerCase();
    return n.includes(first) && n.includes(last);
  });
  // Last name only as last resort
  if (!match) match = list.find(p => (p.PLAYER_NAME || p.name || '').toLowerCase().includes(last));
  return match || null;
}

// ─────────────────────────────────────────────────────
// NBA STATS FILE LOADER — cached in memory, not re-read every request
// ─────────────────────────────────────────────────────
function loadNBAStats() {
  const now = Date.now();
  if (nbaStatsCache && (now - lastStatsDiskRead) < 5 * 60 * 1000) return nbaStatsCache;

  const load = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return null; }
  };

  const exists = (f) => fs.existsSync(f);

  // Core files
  nbaStatsCache = {
    // General
    teamAdvanced:       load('team_advanced.json'),
    teamBase:           load('team_base.json'),
    teamTraditional:    load('team_traditional.json'),
    teamFourFactors:    load('team_four_factors.json'),
    teamMisc:           load('team_misc.json'),
    teamScoring:        load('team_scoring.json'),
    teamOppShooting:    load('team_opp_shooting.json'),
    teamDefense:        load('team_defense.json'),
    teamPaintDef:       load('team_paint_defense.json'),
    // Player general
    playerStats:        load('player_stats.json'),
    playerAdvanced:     load('player_advanced.json'),
    playerMisc:         load('player_misc.json'),
    playerScoring:      load('player_scoring.json'),
    playerOpponent:     load('player_opponent.json'),
    playerPaint:        load('player_paint_stats.json'),
    // Playtypes (player offense)
    playtypeIso:        load('playtype_isolation_player_off.json'),
    playtypeTransition: load('playtype_transition_player_off.json'),
    playtypePRBall:     load('playtype_ballhandler_player_off.json'),
    playtypePRRoll:     load('playtype_rollman_player_off.json'),
    playtypePostUp:     load('playtype_postup_player_off.json'),
    playtypeSpotUp:     load('playtype_spotup_player_off.json'),
    playtypeCut:        load('playtype_cut_player_off.json'),
    playtypeHandoff:    load('playtype_handoff_player_off.json'),
    playtypeOffScreen:  load('playtype_offscreen_player_off.json'),
    playtypePutbacks:   load('playtype_putbacks_player_off.json'),
    // Playtypes (team defense)
    teamDefIso:         load('playtype_isolation_team_def.json'),
    teamDefTransition:  load('playtype_transition_team_def.json'),
    teamDefPRBall:      load('playtype_ballhandler_team_def.json'),
    teamDefPRRoll:      load('playtype_rollman_team_def.json'),
    teamDefPostUp:      load('playtype_postup_team_def.json'),
    teamDefSpotUp:      load('playtype_spotup_team_def.json'),
    teamDefCut:         load('playtype_cut_team_def.json'),
    teamDefHandoff:     load('playtype_handoff_team_def.json'),
    teamDefOffScreen:   load('playtype_offscreen_team_def.json'),
    // Tracking
    trackingDrives:     load('tracking_drives_player.json'),
    trackingCatchShoot: load('tracking_catchshoot_player.json'),
    trackingPassing:    load('tracking_passing_player.json'),
    trackingTouches:    load('tracking_touches_player.json'),
    trackingPullUp:     load('tracking_pullupshot_player.json'),
    trackingElbow:      load('tracking_elbowtouch_player.json'),
    trackingPost:       load('tracking_posttouch_player.json'),
    trackingPaint:      load('tracking_painttouch_player.json'),
    trackingSpeed:      load('tracking_speeddistance_player.json'),
    trackingEfficiency: load('tracking_efficiency_player.json'),
    trackingOffReb:     load('tracking_offensivereboundchances_player.json'),
    trackingDefReb:     load('tracking_defensivereboundchances_player.json'),
    // Defense dashboard
    defenseOverall:     load('defense_overall.json'),
    defense3PT:         load('defense_3pt.json'),
    defense2PT:         load('defense_2pt.json'),
    defenseLT6ft:       load('defense_lt6ft.json'),
    defenseLT10ft:      load('defense_lt10ft.json'),
    defenseGT15ft:      load('defense_gt15ft.json'),
    // Shot dashboard
    shotDashGeneral:    load('shotdash_general_player.json'),
    shotDashShotClock:  load('shotdash_shotclock_player.json'),
    shotDashDribbles:   load('shotdash_dribbles_player.json'),
    shotDashTouch:      load('shotdash_touchtime_player.json'),
    shotDashCloseDef:   load('shotdash_closestdef_player.json'),
    // Opponent shot dashboard (team)
    oppShotGeneral:     load('opp_shotdash_general_team.json'),
    oppShotClock:       load('opp_shotdash_shotclock_team.json'),
    oppShotDribbles:    load('opp_shotdash_dribbles_team.json'),
    oppShotTouch:       load('opp_shotdash_touchtime_team.json'),
    oppShotCloseDef:    load('opp_shotdash_closestdef_team.json'),
    // Hustle
    hustlePlayer:       load('hustle_player.json'),
    hustleTeam:         load('hustle_team.json'),

    dataAvailable: {
      teamAdvanced:    exists('team_advanced.json'),
      teamPaintDef:    exists('team_paint_defense.json'),
      teamOppShooting: exists('team_opp_shooting.json'),
      teamMisc:        exists('team_misc.json'),
      teamFourFactors: exists('team_four_factors.json'),
      playerStats:     exists('player_stats.json'),
      playerAdvanced:  exists('player_advanced.json'),
      playerPaint:     exists('player_paint_stats.json'),
      playtypes:       exists('playtype_isolation_player_off.json'),
      tracking:        exists('tracking_drives_player.json'),
      defense:         exists('defense_overall.json'),
      shotDash:        exists('shotdash_general_player.json'),
      hustle:          exists('hustle_player.json'),
    }
  };

  lastStatsDiskRead = now;
  const loaded = Object.values(nbaStatsCache.dataAvailable).filter(Boolean).length;
  console.log(`[Cache] NBA stats loaded (${loaded}/13 categories available)`);
  return nbaStatsCache;
}

// ─────────────────────────────────────────────────────
// ESPN ROSTER FETCHER — cached 6 hours per team
// ─────────────────────────────────────────────────────
async function fetchESPNRoster(teamName) {
  const abbr = resolveESPNTeam(teamName);
  if (!abbr) return { error: `Unknown team: ${teamName}`, players: [] };

  const now = Date.now();
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (rosterCache[abbr] && (now - (lastRosterFetch[abbr] || 0)) < SIX_HOURS) {
    return rosterCache[abbr];
  }

  try {
    const res = await axios.get(`${ESPN_BASE}/teams/${abbr}/roster`, { timeout: 5000 });
    const raw = res.data?.athletes || [];

    // ESPN has two response formats:
    // Grouped: [ { position: 'G', items: [players] } ]  -- older format
    // Flat:    [ { id, fullName, ... } ]                 -- newer format
    // Detect which by checking if first element has 'items'
    const isGrouped = raw.length > 0 && Array.isArray(raw[0]?.items);
    const playerList = isGrouped
      ? raw.flatMap(group => group.items || [])
      : raw.filter(p => p.fullName); // flat format — filter out non-player entries

    const mapPlayer = (p) => ({
      name:       p.fullName || p.displayName || 'Unknown',
      position:   p.position?.abbreviation || p.position?.name || 'N/A',
      jersey:     p.jersey || p.displayNumber || '?',
      height:     p.height
        ? `${Math.floor(p.height/12)}'${p.height%12}"`
        : (p.displayHeight || 'N/A'),
      weight:     p.weight ? `${p.weight}lbs` : (p.displayWeight || 'N/A'),
      status:     p.injuries?.[0]?.status || p.status?.type?.name || 'Active',
      injuryNote: p.injuries?.[0]?.longComment || p.injuries?.[0]?.shortComment || null,
    });

    const players = playerList.map(mapPlayer).filter(p => p.name !== 'Unknown');

    const result = {
      team: teamName,
      abbr,
      fetchedAt: new Date().toISOString(),
      source: 'ESPN (live)',
      playerCount: players.length,
      players,
      starters: players.filter(p => ['PG','SG','SF','PF','C'].includes(p.position)).slice(0, 8),
      injured:  players.filter(p => p.status !== 'Active'),
    };

    rosterCache[abbr] = result;
    lastRosterFetch[abbr] = now;
    console.log(`[ESPN] Roster fetched: ${teamName} (${players.length} players)`);
    return result;
  } catch (err) {
    console.error(`[ESPN] Roster fetch failed for ${teamName}:`, err.message);
    return { error: err.message, team: teamName, players: [] };
  }
}

// ─────────────────────────────────────────────────────
// TODAY'S GAMES
// ─────────────────────────────────────────────────────
async function fetchTodaysGames() {
  try {
    const res = await axios.get(`${BALLDONTLIE}/games`, {
      params: { dates: [getToday()], per_page: 15 },
      headers: { Authorization: process.env.BALLDONTLIE_KEY },
      timeout: 10000
    });
    todaysGames = res.data.data || [];
    console.log(`[BDL] ${todaysGames.length} games fetched for ${getToday()}`);
  } catch (err) {
    console.error('[BDL] Games fetch failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────
// PLAYER STATS (BallDontLie)
// ─────────────────────────────────────────────────────
async function fetchPlayerStats(playerName) {
  if (playerStatsCache[playerName]) return playerStatsCache[playerName];

  try {
    const bdlKey = process.env.BALLDONTLIE_KEY;
    const searchRes = await axios.get(`${BALLDONTLIE}/players`, {
      params: { search: playerName, per_page: 10 },
      headers: { Authorization: bdlKey },
      timeout: 10000
    });

    const players = searchRes.data.data || [];
    if (!players.length) return { error: `Player "${playerName}" not found`, players: [] };

    // Use full-name fuzzy match instead of just taking [0]
    const player = fuzzyMatchPlayer(players.map(p => ({
      ...p, name: `${p.first_name} ${p.last_name}`
    })), playerName) || players[0];

    const statsRes = await axios.get(`${BALLDONTLIE}/stats`, {
      // FIX: season 2025 = the 2025-26 season in BallDontLie's convention
      params: { player_ids: [player.id], per_page: 15, seasons: [2025] },
      headers: { Authorization: process.env.BALLDONTLIE_KEY },
      timeout: 10000
    });

    const allGames = (statsRes.data.data || [])
      .filter(g => g.min && g.min !== '0' && parseInt(g.min) > 5)
      .sort((a, b) => new Date(b.game.date) - new Date(a.game.date));

    // Fallback to 2024 season if current season has no data yet
    let games = allGames;
    if (games.length < 3) {
      const fallback = await axios.get(`${BALLDONTLIE}/stats`, {
        params: { player_ids: [player.id], per_page: 15, seasons: [2024] },
        headers: { Authorization: process.env.BALLDONTLIE_KEY },
        timeout: 10000
      });
      games = (fallback.data.data || [])
        .filter(g => g.min && g.min !== '0' && parseInt(g.min) > 5)
        .sort((a, b) => new Date(b.game.date) - new Date(a.game.date));
    }

    const last5  = games.slice(0, 5);
    const last10 = games.slice(0, 10);
    const pts5   = parseFloat(calcAvg(last5, 'pts'));
    const pts10  = parseFloat(calcAvg(last10, 'pts'));
    const hotCold = pts5 > pts10 + 3 ? 'HOT' : pts5 < pts10 - 3 ? 'COLD' : 'NEUTRAL';

    const result = {
      player: {
        id:       player.id,
        name:     `${player.first_name} ${player.last_name}`,
        team:     player.team?.full_name || 'Unknown',
        position: player.position || 'Unknown',
        height:   `${player.height_feet || '?'}' ${player.height_inches || '?'}"`,
      },
      form: hotCold,
      minutesStability: parseFloat(calcStdDev(last10, 'min')) > 5 ? 'VOLATILE' : 'STABLE',
      averages: {
        pts:      calcAvg(last10, 'pts'),
        reb:      calcAvg(last10, 'reb'),
        ast:      calcAvg(last10, 'ast'),
        min:      calcAvg(last10, 'min'),
        fg3m:     calcAvg(last10, 'fg3m'),
        fg_pct:   calcAvg(last10, 'fg_pct'),
        stl:      calcAvg(last10, 'stl'),
        blk:      calcAvg(last10, 'blk'),
        turnover: calcAvg(last10, 'turnover')
      },
      last5Games: last5.map(g => ({
        date:     g.game?.date?.split('T')[0] || 'N/A',
        opponent: g.game?.home_team_id === player.team_id
          ? g.game?.visitor_team?.full_name
          : g.game?.home_team?.full_name,
        pts: g.pts, reb: g.reb, ast: g.ast,
        fg3m: g.fg3m, min: g.min,
        fg_pct: g.fg_pct ? (g.fg_pct * 100).toFixed(0) + '%' : 'N/A'
      })),
      gamesAnalyzed: games.length
    };

    playerStatsCache[playerName] = result;
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────────────
// LINEUPS (Tank01 / RapidAPI)
// ─────────────────────────────────────────────────────
async function fetchLineups() {
  const THIRTY_MIN = 30 * 60 * 1000;
  if (lineupCache && lastLineupFetch && (Date.now() - lastLineupFetch) < THIRTY_MIN) return lineupCache;
  try {
    const res = await axios.get(`https://${RAPIDAPI_HOST}/getNBAGamesForDate`, {
      params: { gameDate: getTodayCompact() },
      headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST },
      timeout: 10000
    });
    lineupCache = res.data;
    lastLineupFetch = Date.now();
    return lineupCache;
  } catch (err) {
    return { error: 'Lineups unavailable' };
  }
}

// ─────────────────────────────────────────────────────
// PROP LINES (The Odds API) — with timeout guard
// ─────────────────────────────────────────────────────
async function fetchPropLines(playerName, propType) {
  if (!process.env.ODDS_API_KEY || process.env.ODDS_API_KEY.includes('your_')) return { error: 'No odds key' };
  const propMap = {
    points: 'player_points', rebounds: 'player_rebounds',
    assists: 'player_assists', '3pm': 'player_threes',
    pra: 'player_points_rebounds_assists', steals: 'player_steals', blocks: 'player_blocks'
  };
  try {
    const market = propMap[propType] || 'player_points';
    const eventsRes = await axios.get(`${ODDS_BASE}/sports/basketball_nba/events`, {
      params: { apiKey: process.env.ODDS_API_KEY },
      timeout: 8000
    });

    const lines = {};
    const lastName = playerName.toLowerCase().split(' ').pop();

    // Run event lookups in parallel with a 5-event cap and timeout
    const eventSlice = (eventsRes.data || []).slice(0, 5);
    await Promise.allSettled(eventSlice.map(async event => {
      try {
        const oddsRes = await axios.get(`${ODDS_BASE}/sports/basketball_nba/events/${event.id}/odds`, {
          params: { apiKey: process.env.ODDS_API_KEY, regions: 'us', markets: market, oddsFormat: 'american' },
          timeout: 6000
        });
        for (const bm of (oddsRes.data.bookmakers || [])) {
          for (const mkt of (bm.markets || [])) {
            for (const o of (mkt.outcomes || [])) {
              if (o.description?.toLowerCase().includes(lastName)) {
                if (!lines[bm.title]) lines[bm.title] = {};
                lines[bm.title][o.name] = { point: o.point, price: o.price };
              }
            }
          }
        }
      } catch (_) {}
    }));

    let softestLine = null, softestBook = null;
    for (const [book, data] of Object.entries(lines)) {
      const ol = data['Over']?.point;
      if (ol && (!softestLine || ol < softestLine)) { softestLine = ol; softestBook = book; }
    }
    return { lines, softestLine, softestBook, market };
  } catch (err) {
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// MATHEMATICAL PROJECTION ENGINE
// Calculates projection independently of posted line
// Prevents anchoring bias where Claude mirrors the user's line
// ─────────────────────────────────────────────────────────────────
const LEAGUE_AVG_PACE = 99.5;

function calcWeightedAvg(l5, l10, season) {
  const v5 = parseFloat(l5) || 0;
  const v10 = parseFloat(l10) || 0;
  const vs  = parseFloat(season) || v10;
  if (!v5 && !v10) return null;
  return (v5 * 0.45) + (v10 * 0.30) + (vs * 0.25);
}

function calcPaceAdj(proj, oppPace) {
  if (!oppPace || !proj) return proj;
  const multiplier = Math.sqrt(parseFloat(oppPace) / LEAGUE_AVG_PACE);
  return proj * multiplier;
}

function calcDvPCoeff(oppDefRating) {
  if (!oppDefRating) return 1.0;
  const leagueAvg = 113.0;
  const raw = leagueAvg / parseFloat(oppDefRating);
  return 1 + (raw - 1) * 0.6; // dampen extreme values
}

function calcUsageInflation(playerRoster) {
  if (!playerRoster?.injured?.length) return 1.0;
  const major = playerRoster.injured.filter(p =>
    p.status === 'Out' || p.status === 'Doubtful'
  ).length;
  if (major >= 2) return 1.14;
  if (major === 1) return 1.08;
  return 1.0;
}

function buildProjection(playerStats, ctx, propType) {
  if (!playerStats || playerStats.error) return null;
  const avgs = playerStats.averages || {};

  // Get base stat value for prop type
  let l10Val, seasonVal;
  if (propType === 'pra') {
    l10Val = (parseFloat(avgs.pts)||0) + (parseFloat(avgs.reb)||0) + (parseFloat(avgs.ast)||0);
    seasonVal = l10Val;
  } else {
    const statKey = { points:'pts', rebounds:'reb', assists:'ast',
                      '3pm':'fg3m', steals:'stl', blocks:'blk' }[propType] || 'pts';
    l10Val = parseFloat(avgs[statKey]) || 0;
    seasonVal = l10Val;
  }

  // Calculate L5 from game log
  let l5Val = l10Val;
  if (playerStats.last5Games?.length >= 3) {
    const games = playerStats.last5Games;
    if (propType === 'pra') {
      const vals = games.map(g => (parseFloat(g.pts)||0)+(parseFloat(g.reb)||0)+(parseFloat(g.ast)||0));
      l5Val = vals.reduce((a,b)=>a+b,0) / vals.length;
    } else {
      const statKey = { points:'pts', rebounds:'reb', assists:'ast',
                        '3pm':'fg3m', steals:'stl', blocks:'blk' }[propType] || 'pts';
      const vals = games.map(g => parseFloat(g[statKey]) || 0);
      l5Val = vals.reduce((a,b)=>a+b,0) / vals.length;
    }
  }

  // Step 1: Weighted rolling average
  let proj = calcWeightedAvg(l5Val, l10Val, seasonVal);
  if (!proj) return null;

  // Step 2: Pace adjustment
  proj = calcPaceAdj(proj, ctx.oppAdvanced?.PACE);

  // Step 3: Defensive matchup coefficient
  proj = proj * calcDvPCoeff(ctx.oppAdvanced?.DEF_RATING);

  // Step 4: Usage inflation (teammate injuries)
  proj = proj * calcUsageInflation(ctx.playerRoster);

  // Step 5: Form adjustment
  if (playerStats.form === 'HOT')  proj *= 1.05;
  if (playerStats.form === 'COLD') proj *= 0.95;
  if (playerStats.minutesStability === 'VOLATILE') proj *= 0.97;

  // Confidence score (math-based, not Claude's guess)
  let conf = 50;
  if (playerStats.minutesStability === 'STABLE') conf += 10;
  if ((playerStats.gamesAnalyzed || 0) >= 10) conf += 8;
  else if ((playerStats.gamesAnalyzed || 0) >= 5) conf += 4;
  if (ctx.oppAdvanced) conf += 10;
  if (ctx.playerRoster) conf += 5;
  if (l5Val !== l10Val) conf += 6; // have real L5 data
  if (!ctx.dataAvailable?.teamAdvanced) conf -= 8;
  conf = Math.max(30, Math.min(88, Math.round(conf)));

  return {
    projection:  parseFloat(proj.toFixed(1)),
    l5Avg:       parseFloat(l5Val.toFixed(1)),
    l10Avg:      parseFloat(l10Val.toFixed(1)),
    dvpCoeff:    parseFloat(calcDvPCoeff(ctx.oppAdvanced?.DEF_RATING).toFixed(3)),
    paceAdj:     ctx.oppAdvanced?.PACE ? parseFloat((proj).toFixed(1)) : null,
    usageMult:   parseFloat(calcUsageInflation(ctx.playerRoster).toFixed(3)),
    form:        playerStats.form,
    confidence:  conf,
    oppPace:     ctx.oppAdvanced?.PACE || null,
    oppDefRtg:   ctx.oppAdvanced?.DEF_RATING || null,
  };
}

function calcEdgeScore(mathProj, postedLine) {
  if (!mathProj || !postedLine) return 0;
  const line = parseFloat(postedLine);
  if (!line || line <= 0) return 0;
  // Raw percentage edge — no dampening
  // -5% = -5 score (UNDER), +5% = +5 score (OVER)
  // Capped at ±10 for extreme cases
  const rawEdgePct = ((mathProj - line) / line) * 100;
  return Math.max(-10, Math.min(10, parseFloat(rawEdgePct.toFixed(1))));
}

app.get('/api/health', (req, res) => {
  const stats = loadNBAStats();
  res.json({
    status: 'WIN AI running',
    gamesLoaded: todaysGames.length,
    rostersCached: Object.keys(rosterCache).length,
    dataAvailable: stats?.dataAvailable || {},
    time: new Date().toISOString()
  });
});

app.get('/api/today', async (req, res) => {
  if (!todaysGames.length) await fetchTodaysGames();
  res.json({
    date: getToday(),
    games: todaysGames.map(g => ({
      id: g.id, home: g.home_team.full_name,
      away: g.visitor_team.full_name, status: g.status
    }))
  });
});

app.get('/api/player-stats', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(await fetchPlayerStats(name));
});

// ESPN roster endpoint
app.get('/api/roster', async (req, res) => {
  const { team } = req.query;
  if (!team) return res.status(400).json({ error: 'team required' });
  res.json(await fetchESPNRoster(team));
});

app.get('/api/nba-stats', (req, res) => {
  const stats = loadNBAStats();
  if (!stats) return res.status(404).json({ error: 'Run fetch_stats.py first' });
  const { team } = req.query;
  if (team) {
    return res.json({
      advanced:    stats.teamAdvanced?.find(t => t.TEAM_NAME.toLowerCase().includes(team.toLowerCase())),
      oppShooting: stats.teamOppShooting?.find(t => t.TEAM_NAME.toLowerCase().includes(team.toLowerCase())),
      paintDef:    stats.teamPaintDef?.find(t => t.TEAM_NAME.toLowerCase().includes(team.toLowerCase())),
      dataAvailable: stats.dataAvailable
    });
  }
  res.json(stats);
});

// ─────────────────────────────────────────────────────
// MAIN PROP CONTEXT — assembles everything for Claude
// ─────────────────────────────────────────────────────
app.get('/api/prop-context', async (req, res) => {
  const { player, opponent, propType } = req.query;
  if (!player || !opponent) return res.status(400).json({ error: 'player and opponent required' });

  console.log(`[Analyze] ${player} vs ${opponent} — ${propType}`);

  // Load nba stats from cache (disk read at most every 5 min)
  const nbaStats = loadNBAStats();

  // Fetch player stats first (need team name for second roster call)
  const [playerStats, oppRoster, lineups, propLines] = await Promise.all([
    fetchPlayerStats(player),
    fetchESPNRoster(opponent),
    fetchLineups(),
    fetchPropLines(player, propType || 'points')
  ]);

  // Fetch player's own team roster in parallel with the stat lookups above
  // (done after playerStats so we have the team name)
  const playerTeamName = playerStats?.player?.team || '';
  const playerRoster = playerTeamName
    ? await fetchESPNRoster(playerTeamName)
    : null;

  // Team-level stats from nba.com files
  const oppAdvanced = nbaStats?.teamAdvanced?.find(t =>
    t.TEAM_NAME.toLowerCase().includes(opponent.toLowerCase())) || null;

  const oppShooting = nbaStats?.teamOppShooting?.find(t =>
    t.TEAM_NAME.toLowerCase().includes(opponent.toLowerCase())) || null;

  const oppPaintDef = nbaStats?.teamPaintDef?.find(t =>
    t.TEAM_NAME.toLowerCase().includes(opponent.toLowerCase())) || null;

  const playerTeamAdvanced = nbaStats?.teamAdvanced?.find(t =>
    t.TEAM_NAME.toLowerCase().includes(playerTeamName.toLowerCase())) || null;

  // Player-level stats from nba.com files — full name fuzzy match
  const playerSeasonStats = nbaStats?.playerStats
    ? fuzzyMatchPlayer(nbaStats.playerStats, player) : null;

  const playerPaintStats = nbaStats?.playerPaint
    ? fuzzyMatchPlayer(nbaStats.playerPaint, player) : null;

  // Today's confirmed game
  const todayGame = todaysGames.find(g =>
    g.home_team.full_name.toLowerCase().includes(opponent.toLowerCase()) ||
    g.visitor_team.full_name.toLowerCase().includes(opponent.toLowerCase()) ||
    g.home_team.full_name.toLowerCase().includes(playerTeamName.toLowerCase()) ||
    g.visitor_team.full_name.toLowerCase().includes(playerTeamName.toLowerCase())
  ) || null;

  // ── Pull ALL new stat categories for this player and opponent ──

  // Player playtypes (which play types they score on and how efficiently)
  const playerPlaytypes = {};
  const playtypeKeys = [
    ['iso','playtypeIso'],['transition','playtypeTransition'],
    ['prBall','playtypePRBall'],['prRoll','playtypePRRoll'],
    ['postUp','playtypePostUp'],['spotUp','playtypeSpotUp'],
    ['cut','playtypeCut'],['handoff','playtypeHandoff'],
    ['offScreen','playtypeOffScreen'],['putbacks','playtypePutbacks'],
  ];
  for (const [key, src] of playtypeKeys) {
    const match = nbaStats?.[src] ? fuzzyMatchPlayer(nbaStats[src], player) : null;
    if (match) playerPlaytypes[key] = match;
  }

  // Opponent team defense by playtype (how well they defend each play type)
  const oppDefPlaytypes = {};
  const teamDefKeys = [
    ['iso','teamDefIso'],['transition','teamDefTransition'],
    ['prBall','teamDefPRBall'],['prRoll','teamDefPRRoll'],
    ['postUp','teamDefPostUp'],['spotUp','teamDefSpotUp'],
    ['cut','teamDefCut'],['handoff','teamDefHandoff'],['offScreen','teamDefOffScreen'],
  ];
  for (const [key, src] of teamDefKeys) {
    const match = nbaStats?.[src]?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase()));
    if (match) oppDefPlaytypes[key] = match;
  }

  // Player tracking stats
  const playerTracking = {};
  const trackingKeys = [
    ['drives','trackingDrives'],['catchShoot','trackingCatchShoot'],
    ['passing','trackingPassing'],['touches','trackingTouches'],
    ['pullUp','trackingPullUp'],['elbow','trackingElbow'],
    ['post','trackingPost'],['paint','trackingPaint'],
    ['speed','trackingSpeed'],['offReb','trackingOffReb'],['defReb','trackingDefReb'],
  ];
  for (const [key, src] of trackingKeys) {
    const match = nbaStats?.[src] ? fuzzyMatchPlayer(nbaStats[src], player) : null;
    if (match) playerTracking[key] = match;
  }

  // Player shot dashboard (where/how they shoot)
  const playerShotDash = {};
  const shotDashKeys = [
    ['general','shotDashGeneral'],['shotClock','shotDashShotClock'],
    ['dribbles','shotDashDribbles'],['touchTime','shotDashTouch'],
    ['closestDef','shotDashCloseDef'],
  ];
  for (const [key, src] of shotDashKeys) {
    const match = nbaStats?.[src] ? fuzzyMatchPlayer(nbaStats[src], player) : null;
    if (match) playerShotDash[key] = match;
  }

  // Opponent shot defense dashboard (how they defend by shot type/situation)
  const oppShotDefense = {};
  const oppShotKeys = [
    ['general','oppShotGeneral'],['shotClock','oppShotClock'],
    ['dribbles','oppShotDribbles'],['touchTime','oppShotTouch'],
    ['closestDef','oppShotCloseDef'],
  ];
  for (const [key, src] of oppShotKeys) {
    const match = nbaStats?.[src]?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase()));
    if (match) oppShotDefense[key] = match;
  }

  // Defense dashboard for opponent (how they defend by shot distance)
  const oppDefDashboard = {};
  const defZoneKeys = [
    ['overall','defenseOverall'],['threePT','defense3PT'],
    ['twoPT','defense2PT'],['lt6ft','defenseLT6ft'],
    ['lt10ft','defenseLT10ft'],['gt15ft','defenseGT15ft'],
  ];
  for (const [key, src] of defZoneKeys) {
    const match = nbaStats?.[src]?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())
      || t.CLOSE_DEF_PERSON_ID !== undefined); // player-level defense
    if (match) oppDefDashboard[key] = match;
  }

  // Misc stats (paint points, second chance, fast break)
  const playerMiscStats  = nbaStats?.playerMisc ? fuzzyMatchPlayer(nbaStats.playerMisc, player) : null;
  const playerScoringDist = nbaStats?.playerScoring ? fuzzyMatchPlayer(nbaStats.playerScoring, player) : null;
  const playerAdvancedStats = nbaStats?.playerAdvanced ? fuzzyMatchPlayer(nbaStats.playerAdvanced, player) : null;
  const playerHustle = nbaStats?.hustlePlayer ? fuzzyMatchPlayer(nbaStats.hustlePlayer, player) : null;

  // Team misc/four factors for opponent
  const oppMisc       = nbaStats?.teamMisc?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;
  const oppFourFact   = nbaStats?.teamFourFactors?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;
  const oppScoring    = nbaStats?.teamScoring?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;
  const oppHustle     = nbaStats?.hustleTeam?.find(t => t.TEAM_NAME?.toLowerCase().includes(opponent.toLowerCase())) || null;

  // Calculate math-based projection BEFORE sending to Claude
  // This prevents the prompt from containing the line until after projection
  const mathProjection = buildProjection(playerStats, {
    oppAdvanced, oppShooting, oppPaintDef, oppFourFact,
    playerRoster, dataAvailable: nbaStats?.dataAvailable || {}
  }, propType || 'points');

  res.json({
    fetchedAt:          new Date().toISOString(),
    date:               getToday(),
    dataAvailable:      nbaStats?.dataAvailable || {},
    mathProjection,     // Independent mathematical projection
    // Player
    playerStats,
    playerSeasonStats,
    playerAdvancedStats,
    playerPaintStats,
    playerMiscStats,
    playerScoringDist,
    playerHustle,
    playerPlaytypes,
    playerTracking,
    playerShotDash,
    playerRoster,
    // Opponent team
    oppAdvanced,
    oppShooting,
    oppPaintDef,
    oppMisc,
    oppFourFact,
    oppScoring,
    oppHustle,
    oppDefPlaytypes,
    oppDefDashboard,
    oppShotDefense,
    oppRoster,
    // Player team
    playerTeamAdvanced,
    // Schedule
    todayGame,
    allTodaysGames: todaysGames.map(g => `${g.visitor_team.full_name} @ ${g.home_team.full_name}`),
    lineups:  lineups?.error ? null : lineups,
    propLines: propLines?.error ? null : propLines,
  });
});

// ─────────────────────────────────────────────────────
// CLAUDE PROXY
// ─────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_KEY.includes('your_')) {
    return res.status(500).json({ error: 'Anthropic API key not configured in .env' });
  }
  try {
    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-20250514', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 }
    );
    res.json({ response: claudeRes.data.content.map(b => b.text || '').join('') });
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
    const errStatus = err.response?.status || 500;
    console.error(`[Claude] Error ${errStatus}:`, errMsg);
    console.error('[Claude] Full error:', JSON.stringify(err.response?.data || {}, null, 2));
    res.status(500).json({ error: errMsg, status: errStatus });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── PLAYER MATCHUP LOOKUP ─────────────────────────────────────────
// Given a player name, finds today's opponent automatically
app.get('/api/player-matchup', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });

  // Make sure today's games are loaded
  if (!todaysGames.length) await fetchTodaysGames();

  try {
    // Search BDL for the player to get their team
    const searchRes = await axios.get(`${BALLDONTLIE}/players`, {
      params: { search: name, per_page: 5 },
      headers: { Authorization: process.env.BALLDONTLIE_KEY },
      timeout: 8000
    });

    const players = searchRes.data.data || [];
    if (!players.length) return res.json({ found: false, error: 'Player not found' });

    // Fuzzy match
    const player = fuzzyMatchPlayer(
      players.map(p => ({ ...p, name: `${p.first_name} ${p.last_name}` })),
      name
    ) || players[0];

    const playerTeam = player.team?.full_name || '';
    const playerTeamId = player.team?.id;

    // Find today's game for this player's team
    const todayGame = todaysGames.find(g =>
      g.home_team.full_name === playerTeam ||
      g.visitor_team.full_name === playerTeam ||
      g.home_team.id === playerTeamId ||
      g.visitor_team.id === playerTeamId
    );

    if (!todayGame) {
      return res.json({
        found: true,
        playing: false,
        player: `${player.first_name} ${player.last_name}`,
        team: playerTeam,
        message: `${playerTeam} does not play today`
      });
    }

    // Determine opponent
    const isHome = todayGame.home_team.full_name === playerTeam ||
                   todayGame.home_team.id === playerTeamId;
    const opponent = isHome
      ? todayGame.visitor_team.full_name
      : todayGame.home_team.full_name;

    const gameTime = todayGame.status || 'TBD';

    return res.json({
      found: true,
      playing: true,
      player: `${player.first_name} ${player.last_name}`,
      team: playerTeam,
      opponent,
      isHome,
      gameTime,
      gameId: todayGame.id
    });

  } catch (err) {
    console.error('[matchup] Error:', err.message);
    res.json({ found: false, error: err.message });
  }
});

// ── DEBUG ROUTE ───────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const results = { time: new Date().toISOString() };
  try {
    const r = await axios.get(`${BALLDONTLIE}/games`, {
      params: { dates: [getToday()], per_page: 3 },
      headers: { Authorization: process.env.BALLDONTLIE_KEY },
      timeout: 8000
    });
    results.balldontlie = { ok: true, games: r.data.data?.length || 0 };
  } catch (e) {
    results.balldontlie = { ok: false, status: e.response?.status, error: e.response?.data?.error || e.message };
  }
  try {
    const r = await axios.get(`${ESPN_BASE}/teams/bos/roster`, { timeout: 5000 });
    const espnRaw = r.data?.athletes || [];
    const espnIsGrouped = espnRaw.length > 0 && Array.isArray(espnRaw[0]?.items);
    const espnCount = espnIsGrouped
      ? espnRaw.flatMap(g => g.items||[]).length
      : espnRaw.filter(p => p.fullName).length;
    results.espn = {
      ok: true,
      players: espnCount,
      format: espnIsGrouped ? 'grouped' : 'flat',
      rawGroups: espnRaw.length
    };
  } catch (e) {
    results.espn = { ok: false, error: e.message };
  }
  results.env = {
    balldontlie: !!process.env.BALLDONTLIE_KEY,
    anthropic: !!(process.env.ANTHROPIC_KEY && !process.env.ANTHROPIC_KEY.includes('your_')),
    oddsApi: !!process.env.ODDS_API_KEY,
    rapidApi: !!process.env.RAPIDAPI_KEY,
    anthropicKeyPrefix: process.env.ANTHROPIC_KEY?.slice(0,12) + '...'
  };
  const fs = require('fs');
  results.dataFiles = {
    teamAdvanced: fs.existsSync('team_advanced.json'),
    playerStats:  fs.existsSync('player_stats.json'),
    teamPaint:    fs.existsSync('team_paint_defense.json'),
    teamOppShoot: fs.existsSync('team_opp_shooting.json'),
    playerPaint:  fs.existsSync('player_paint_stats.json'),
  };
  results.gamesLoaded = todaysGames.length;
  results.cacheSize = Object.keys(playerStatsCache).length;
  res.json(results);
});


// ─────────────────────────────────────────────────────
// SCHEDULED JOBS
// ─────────────────────────────────────────────────────
cron.schedule('0 9 * * *', fetchTodaysGames);

// Auto-refresh nba.com stat files every morning at 7am
// This keeps playtypes, tracking, shot dashboard etc current
cron.schedule('0 7 * * *', () => {
  const { spawn } = require('child_process');
  console.log('[CRON] Auto-running fetch_stats.py to refresh nba.com data...');
  const py = spawn('python', ['fetch_stats.py'], { cwd: __dirname });
  py.stdout.on('data', d => console.log('[fetch_stats]', d.toString().trim()));
  py.stderr.on('data', d => console.error('[fetch_stats ERR]', d.toString().trim()));
  py.on('close', code => {
    console.log(`[CRON] fetch_stats.py finished (exit ${code})`);
    // Clear stats cache so new files are loaded
    nbaStatsCache = null;
    lastStatsDiskRead = 0;
  });
});                                          // refresh games 9am daily
cron.schedule('0 0 * * *', () => {                                                      // midnight reset
  playerStatsCache = {};
  lineupCache      = null;
  rosterCache      = {};   // clear rosters — trades announced overnight
  lastRosterFetch  = {};
  nbaStatsCache    = null;
  console.log('[CRON] All caches cleared');
});
cron.schedule('0 12,17 * * *', () => { lastLineupFetch = null; fetchLineups(); });     // lineup refresh at noon + 5pm
cron.schedule('0 8 * * *', () => { rosterCache = {}; lastRosterFetch = {}; });         // roster refresh every morning

// ─────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
fetchTodaysGames().then(() => {
  app.listen(PORT, () => {
    console.log('\n  WIN AI — NBA Props Engine');
    console.log(`  Running → http://localhost:${PORT}`);
    console.log('  ESPN rosters: LIVE (no key needed)');
    console.log('  Stat files: run python fetch_stats.py to refresh\n');
  });
});
