import type { Track } from './types';

/**
 * Rows 1-58 are the entries legible in the reference photos (titles cut off
 * with ".." in the photos are completed with invented endings). Rows 59+ are
 * invented. The list is padded to 139 tracks totalling 585:36, matching the
 * playlist footer in the photos.
 */
const FROM_PHOTOS: Array<[string, string, string]> = [
  ['DENIS HORVAT & LULLIBY', 'WHAT WE LEFT BEHIND', '2:41'],
  ['19:26 & 1LINE', 'ON THE OTHER SIDE', '2:50'],
  ['HELSLOOT', 'I KEEP GOING (FEAT. ARNO)', '4:14'],
  ['MARINO CANAL', 'LUXOR', '4:50'],
  ['KASANGO, KINTAR, BENJI & KYOZO', 'OASIS', '3:39'],
  ['BIRRD', 'OCEAN SWEEP', '5:13'],
  ['DOURAN', 'THE NIGHT BEFORE', '4:40'],
  ['ARODES', 'SOMETHING SPECIAL (FEAT. LIA)', '3:28'],
  ['MEERA (NO)', 'NOVEMBER', '7:19'],
  ['KASABLANCA', 'TIME IS A CIRCLE', '4:18'],
  ['ARTBAT & JOA', 'THE SPOT', '3:15'],
  ['VINTAGE CULTURE & EDDIE THONEICK', 'SHAKE', '4:00'],
  ['ANNA & FREEDOM FIGHTERS', 'BLOOM', '3:54'],
  ['MICHAEL BIBI', 'BAD WOLF (FEAT. KAZ)', '3:05'],
  ['TONIC WALTER', 'SARI', '6:28'],
  ['KIDNAP', 'TEARS - EDIT', '5:09'],
  ['HUGO CANTARRA & ELI & FUR', 'FIREFLIES', '3:42'],
  ['MISS MONIQUE', 'LAND OF SUNSHINE', '4:00'],
  ['SINEGO & XINOBI', 'SI VAS AL MAR', '4:16'],
  ['ANKHOI', 'DO YOU THINK OF ME?', '3:12'],
  ['CHRIS LAKE & ATRIP', 'MAKE YOU MOVE', '2:55'],
  ['MAXI MERAKI', 'FIRST TIME', '3:32'],
  ['HOTLAP', 'RECALL', '3:47'],
  ['ZHU & THEY.', '5STARRR', '3:45'],
  ['GUDFELLA', 'MORNING COFFEE (FEAT. NOA)', '3:02'],
  ['BRUNELLO & HILEL LEV', 'APATHY', '7:07'],
  ['CINTHIE', 'U GOTTA BELIEVE', '8:02'],
  ['ADAM TEN & ASULIN', 'WARAWARA (EXTENDED)', '3:24'],
  ['ALEX WANN', 'IDONE', '4:38'],
  ['PROSPA & MURDA BEATZ', 'BABY', '3:13'],
  ['JOHANNES BRECHT', 'ALL WE GOT', '2:36'],
  ['SULTAN + SHEPARD & SHALLOU', 'WILDFIRE', '5:59'],
  ['FAKEAR', 'THOSE TREES', '3:50'],
  ['AURORA', 'SOME TYPE OF SKIN (SLOWED)', '3:24'],
  ['KIASMOS', 'SPUN', '4:09'],
  ['AERDS', 'ASOMNIUM', '2:51'],
  ['SHAOLIN COWBOY', 'HARDER, STRONGER', '4:32'],
  ['COCO & BREEZY', 'DREAMS', '3:15'],
  ['OSKAR MED K', 'ON THE GROUND', '2:14'],
  ['UMAEDO', 'BODY MOVING', '2:51'],
  ['HOTLAP', "WAITIN'", '3:44'],
  ['WHOMADEWHO & TRIPOLISM', 'FLYING HIGH', '8:59'],
  ['JEREMY OLANDER', 'ARRIVAL', '4:21'],
  ['MONOLINK', 'BEACON (CUROL REMIX)', '3:36'],
  ['MALIVE & DOX', 'OVER & OVER (REWORK)', '2:58'],
  ['ELI & FUR', 'ONE THAT YOU LOVE', '3:05'],
  ['MYD', "YOU'RE A STAR", '4:28'],
  ['BRUNELLO & VARGAS', 'GHOST DANCE', '6:12'],
  ['NATASCHA POLKE & DOURAN', 'GHOSTS OF THE SEA', '4:24'],
  ['SAINTE VIE & IVORY (IT)', 'LIGHTHOUSE', '5:37'],
  ['MCFLY', 'SILHOUETTE', '4:13'],
  ['ADRIATIQUE & EMMIT FENN', 'CLOSE TO ME', '3:16'],
  ['PAN-POT', 'FUNKE', '3:40'],
  ['MAX STYLER, VINTAGE CULTURE & FRIENDS', 'NIGHTFALL', '3:52'],
  ['YOTTO', 'COME BACK BABY', '3:10'],
  ['GE?VHAN', 'DIAMANTE', '4:16'],
  ['IMBERMIND', 'CLOSER THAN EVER (DUB)', '5:11'],
  ['FRENCH 79', 'THE ADVENTURER', '4:16'],
];

// Invented names for padding. Deliberately fictional.
const ARTISTS = [
  'NORTHLIGHT', 'VELA COAST', 'MIRA SOLENNE', 'KAITO & THE FERNS', 'PALE ORCHARD', 'LUMEN DRIFT',
  'SOFT HARBOUR', 'ORIEL', 'TIDEWATER', 'NOVA KESTREL', 'AMBERLINE', 'HALCYON BLUE', 'SATELLITE GARDEN',
  'IRIS VANTE', 'MOONPARK', 'GLASS ATLAS', 'KOVA', 'ELSEWHERE CLUB', 'RUNE & RIVER', 'MAREN HOLT',
  'DUSTLIGHT', 'COASTAL STATIC', 'SILVERFERN', 'OKAPI DREAMS',
];
const TITLES = [
  'AFTERGLOW', 'SLOW TIDES', 'NEON PRAYER', 'FOLD', 'PAPER MOONS', 'SECOND SUN', 'UNDERCURRENT',
  'HOLD THE LINE', 'WARM STATIC', 'LANTERNS', 'STARFIELD', 'LATE TRAIN', 'BLUE HOUR', 'MIRRORS',
  'OPEN WATER', 'GOLDEN DUST', 'ECHO PARK', 'HALF LIGHT', 'NIGHT BLOOM', 'PARALLEL', 'SIGNAL FIRE',
  'VELVET ROOM', 'DRIFTWOOD', 'TELESCOPE', 'COMING HOME', 'SATURDAY SKY', 'LOW ORBIT', 'SUNDIAL',
];
const SUFFIXES = ['', '', '', ' (EXTENDED MIX)', ' (ORIGINAL MIX)', ' (DUB)', ' (RADIO EDIT)', ' - EDIT'];

const TARGET_COUNT = 139;
const TARGET_TOTAL = 585 * 60 + 36;

function parseTime(s: string): number {
  const [m, sec] = s.split(':').map(Number);
  return m * 60 + sec;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDemoPlaylist(): Track[] {
  const tracks: Track[] = FROM_PHOTOS.map(([artist, title, dur], i) => ({
    id: `demo-${i + 1}`,
    artist,
    title,
    duration: parseTime(dur),
    kbps: 256,
    khz: 44,
    channels: 2,
  }));
  const rand = mulberry32(0xd00a);
  let used = tracks.reduce((s, t) => s + t.duration, 0);
  const remaining = TARGET_COUNT - tracks.length;
  for (let k = 0; k < remaining; k++) {
    const i = tracks.length;
    const left = TARGET_COUNT - i;
    const budget = TARGET_TOTAL - used;
    let duration: number;
    if (left === 1) {
      duration = budget;
    } else {
      // Steer toward the average still needed, with plausible spread.
      const avg = budget / left;
      duration = Math.round(Math.max(130, Math.min(560, avg + (rand() - 0.5) * 150)));
    }
    used += duration;
    const artist = ARTISTS[Math.floor(rand() * ARTISTS.length)];
    const title = TITLES[Math.floor(rand() * TITLES.length)] + SUFFIXES[Math.floor(rand() * SUFFIXES.length)];
    tracks.push({
      id: `demo-${i + 1}`,
      artist,
      title,
      duration,
      kbps: rand() < 0.15 ? 320 : 256,
      khz: rand() < 0.1 ? 48 : 44,
      channels: rand() < 0.05 ? 1 : 2,
    });
  }
  return tracks;
}

/** Index of "31. JOHANNES BRECHT - ALL WE GOT", the track loaded in the photos. */
export const DEMO_START_INDEX = 30;
export const DEMO_SOURCE_LABEL = 'DEMO LIBRARY';
