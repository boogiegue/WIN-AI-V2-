"""
WIN AI — NBA Stats Fetcher
Compatible with nba_api 1.11.4 / Python 3.14
Run daily before using WIN AI. Takes 3-5 min due to nba.com rate limiting.
"""
import json, time, os

from nba_api.stats.endpoints import (
    leaguedashteamstats,
    leaguedashplayerstats,
    leaguedashteamptshot,
    leaguedashteamshotlocations,
    leaguedashplayershotlocations,
    leaguedashptdefend,
    leaguedashptstats,
    leaguehustlestatsplayer,
    leaguehustlestatsteam,
    synergyplaytypes,
)

SEASON = '2025-26'
SLEEP  = 2.5

def save(filename, data):
    with open(filename, 'w') as f:
        json.dump(data, f)
    print(f"  Saved {filename} ({len(data)} rows)")

def safe_cols(df, wanted):
    return [c for c in wanted if c in df.columns]

def fetch(label, fn, **kw):
    print(f"[FETCH] {label}...")
    for attempt in range(3):
        try:
            result = fn(**kw)
            # Handle both get_data_frames() and cases where index 0 fails
            frames = result.get_data_frames()
            if not frames or len(frames) == 0:
                print(f"  ERROR: No data frames returned")
                return None
            df = frames[0]
            if df is None or len(df) == 0:
                print(f"  ERROR: Empty data frame")
                return None
            print(f"  OK ({len(df)} rows)")
            return df
        except Exception as e:
            msg = str(e)
            if '429' in msg or 'rate' in msg.lower():
                wait = (attempt + 1) * 10
                print(f"  Rate limited — waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"  ERROR: {e}")
                return None
    print(f"  FAILED after 3 attempts")
    return None

print("=" * 60)
print(f"WIN AI Stats Fetcher | {SEASON}")
print("=" * 60)

# ── TEAM GENERAL ─────────────────────────────────────────────────
# measure_type_detailed_defense is correct for LeagueDashTeamStats
for label, mtype, fname in [
    ("Team Traditional",  "Base",         "team_traditional.json"),
    ("Team Advanced",     "Advanced",     "team_advanced.json"),
    ("Team Four Factors", "Four Factors", "team_four_factors.json"),
    ("Team Misc",         "Misc",         "team_misc.json"),
    ("Team Scoring",      "Scoring",      "team_scoring.json"),
    ("Team Opponent",     "Opponent",     "team_opp_shooting.json"),
    ("Team Defense",      "Defense",      "team_defense.json"),
]:
    df = fetch(label, leaguedashteamstats.LeagueDashTeamStats,
               season=SEASON, measure_type_detailed_defense=mtype)
    if df is not None:
        save(fname, df.to_dict('records'))
    time.sleep(SLEEP)

df = fetch("Team Base", leaguedashteamstats.LeagueDashTeamStats,
           season=SEASON, measure_type_detailed_defense='Base')
if df is not None:
    c = safe_cols(df, ['TEAM_NAME','W','L','PTS','REB','AST','OPP_PTS'])
    save('team_base.json', df[c].to_dict('records'))
time.sleep(SLEEP)

# ── PLAYER GENERAL ────────────────────────────────────────────────
# measure_type_simple_nullable is correct for LeagueDashPlayerStats
for label, mtype, fname in [
    ("Player Traditional", "Base",     "player_stats.json"),
    ("Player Advanced",    "Advanced", "player_advanced.json"),
    ("Player Misc",        "Misc",     "player_misc.json"),
    ("Player Scoring",     "Scoring",  "player_scoring.json"),
    ("Player Opponent",    "Opponent", "player_opponent.json"),
]:
    df = fetch(label, leaguedashplayerstats.LeagueDashPlayerStats,
               season=SEASON, measure_type_simple_nullable=mtype)
    if df is not None:
        save(fname, df.to_dict('records'))
    time.sleep(SLEEP)

# ── TEAM PAINT DEFENSE ────────────────────────────────────────────
df = fetch("Team Paint Defense", leaguedashteamptshot.LeagueDashTeamPtShot,
           season=SEASON, pt_measure_type='PaintTouch',
           per_mode_simple='PerGame', season_type_all_star='Regular Season')
if df is not None:
    save('team_paint_defense.json', df.to_dict('records'))
time.sleep(SLEEP)

# ── PLAYER TRACKING ───────────────────────────────────────────────
# per_mode_simple='PerGame' is correct for LeagueDashPtStats
TRACKING = [
    ('PaintTouch',              'player_paint_stats.json'),
    ('Drives',                  'tracking_drives_player.json'),
    ('CatchShoot',              'tracking_catchshoot_player.json'),
    ('Passing',                 'tracking_passing_player.json'),
    ('Touches',                 'tracking_touches_player.json'),
    ('PullUpShot',              'tracking_pullupshot_player.json'),
    ('ElbowTouch',              'tracking_elbowtouch_player.json'),
    ('PostTouch',               'tracking_posttouch_player.json'),
    ('SpeedDistance',           'tracking_speeddistance_player.json'),
    ('Efficiency',              'tracking_efficiency_player.json'),
    ('OffensiveReboundChances', 'tracking_offrebound_player.json'),
    ('DefensiveReboundChances', 'tracking_defrebound_player.json'),
]
for pt_type, fname in TRACKING:
    df = fetch(f"Tracking {pt_type}", leaguedashptstats.LeagueDashPtStats,
               season=SEASON, pt_measure_type=pt_type,
               per_mode_simple='PerGame', player_or_team='Player',
               season_type_all_star='Regular Season')
    if df is not None:
        save(fname, df.to_dict('records'))
    time.sleep(SLEEP)

for pt_type, fname in [
    ('PaintTouch', 'tracking_painttouch_team.json'),
    ('Drives',     'tracking_drives_team.json'),
]:
    df = fetch(f"Tracking {pt_type} (Team)", leaguedashptstats.LeagueDashPtStats,
               season=SEASON, pt_measure_type=pt_type,
               per_mode_simple='PerGame', player_or_team='Team',
               season_type_all_star='Regular Season')
    if df is not None:
        save(fname, df.to_dict('records'))
    time.sleep(SLEEP)

# ── DEFENSE DASHBOARD ─────────────────────────────────────────────
# defense_category_nullable was renamed — fetch overall only (no zone filter)
# The overall file contains all shot zone data in one frame
df = fetch("Defense Dashboard Overall", leaguedashptdefend.LeagueDashPtDefend,
           season=SEASON,
           per_mode_simple='PerGame',
           season_type_all_star='Regular Season')
if df is not None:
    save('defense_overall.json', df.to_dict('records'))
    print(f"  Columns: {list(df.columns[:10])}")
time.sleep(SLEEP)

# ── SHOT DASHBOARD ────────────────────────────────────────────────
# per_mode_simple_nullable is the correct param for ShotLocations endpoints
SHOT_DASH = [
    ('General',    'GeneralRange'),
    ('ShotClock',  'ShotClockRange'),
    ('Dribbles',   'DribbleRange'),
    ('TouchTime',  'TouchTimeRange'),
    ('ClosestDef', 'CloseDefDistRange'),
]
for label, dtype in SHOT_DASH:
    df = fetch(f"Shot Dashboard {label} (Player)",
               leaguedashplayershotlocations.LeagueDashPlayerShotLocations,
               season=SEASON,
               per_mode_simple_nullable=dtype,    # correct param name
               season_type_all_star='Regular Season')
    if df is not None:
        save(f'shotdash_{label.lower()}_player.json', df.to_dict('records'))
    time.sleep(SLEEP)

    df = fetch(f"Shot Dashboard {label} (Team)",
               leaguedashteamshotlocations.LeagueDashTeamShotLocations,
               season=SEASON,
               per_mode_simple_nullable=dtype,    # correct param name
               season_type_all_star='Regular Season')
    if df is not None:
        save(f'shotdash_{label.lower()}_team.json', df.to_dict('records'))
    time.sleep(SLEEP)

# ── OPPONENT SHOT DASHBOARD ───────────────────────────────────────
for label, dtype in SHOT_DASH:
    df = fetch(f"Opp Shot Dashboard {label}",
               leaguedashteamshotlocations.LeagueDashTeamShotLocations,
               season=SEASON,
               per_mode_simple_nullable=dtype,
               season_type_all_star='Regular Season')
    if df is not None:
        save(f'opp_shotdash_{label.lower()}_team.json', df.to_dict('records'))
    time.sleep(SLEEP)

# ── HUSTLE STATS ──────────────────────────────────────────────────
# per_mode_nullable is correct (not per_mode_time_nullable)
df = fetch("Hustle Player", leaguehustlestatsplayer.LeagueHustleStatsPlayer,
           season=SEASON,
           per_mode_nullable='PerGame',
           season_type_all_star='Regular Season')
if df is not None:
    save('hustle_player.json', df.to_dict('records'))
time.sleep(SLEEP)

df = fetch("Hustle Team", leaguehustlestatsteam.LeagueHustleStatsTeam,
           season=SEASON,
           per_mode_nullable='PerGame',
           season_type_all_star='Regular Season')
if df is not None:
    save('hustle_team.json', df.to_dict('records'))
time.sleep(SLEEP)

# ── PLAYTYPES (Synergy) ───────────────────────────────────────────
# SynergyPlayTypes returns multiple result sets — use index carefully
PLAYTYPES = [
    ('Isolation','isolation'),('Transition','transition'),
    ('PRBallHandler','ballhandler'),('PRRollman','rollman'),
    ('PostUp','postup'),('SpotUp','spotup'),('Handoff','handoff'),
    ('Cut','cut'),('OffScreen','offscreen'),('Putbacks','putbacks'),
]

def fetch_synergy(label, ptype, pot, grp):
    print(f"[FETCH] Playtype {label} ({'player_off' if pot=='P' else 'team_def'})...")
    for attempt in range(3):
        try:
            result = synergyplaytypes.SynergyPlayTypes(
                season=SEASON,
                play_type_nullable=ptype,
                per_mode_simple='PerGame',
                player_or_team_abbreviation=pot,
                type_grouping_nullable=grp,
                season_type_all_star='Regular Season'
            )
            frames = result.get_data_frames()
            # SynergyPlayTypes may return result at index 0 or in normalized dict
            if frames and len(frames) > 0 and frames[0] is not None and len(frames[0]) > 0:
                print(f"  OK ({len(frames[0])} rows)")
                return frames[0]
            # Try normalized dict as fallback
            nd = result.get_normalized_dict()
            if nd:
                first_key = list(nd.keys())[0]
                rows = nd[first_key]
                if rows:
                    import pandas as pd
                    df = pd.DataFrame(rows)
                    print(f"  OK via normalized ({len(df)} rows)")
                    return df
            print(f"  ERROR: No data in response")
            return None
        except Exception as e:
            msg = str(e)
            if '429' in msg or 'rate' in msg.lower():
                wait = (attempt + 1) * 10
                print(f"  Rate limited — waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"  ERROR: {e}")
                return None
    return None

for label, ptype in PLAYTYPES:
    for pot, grp, gname in [('P','offensive','player_off'),('T','defensive','team_def')]:
        df = fetch_synergy(label, ptype, pot, grp)
        if df is not None:
            save(f'playtype_{ptype}_{gname}.json', df.to_dict('records'))
        time.sleep(SLEEP)

# ── SUMMARY ───────────────────────────────────────────────────────
all_files = sorted([f for f in os.listdir('.') if f.endswith('.json')
                    and not f.startswith('package')])
print(f"\n{'='*60}")
print(f"DONE — {len(all_files)} JSON files saved:")
for f in all_files:
    kb = os.path.getsize(f) // 1024
    print(f"  {f:<50} {kb}kb")
print("="*60)
print("\nRun daily before using WIN AI.")
