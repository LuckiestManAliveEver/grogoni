import type {
  CorridorPoolReadiness,
  DispatchFallbackAction,
  ManifestStatus,
  ManifestStopDeliveryStatus
} from "@grogoni/shared-types";

// English and Swahili copy for the corridor-fulfillment cards (field sales and operations). Field
// staff often run the device in Swahili, so these cards follow the browser language instead of
// hard-coding English like the older record cards.
export type FulfillmentLanguage = "en" | "sw";

export function fulfillmentLanguage(): FulfillmentLanguage {
  const language =
    typeof navigator === "undefined" ? "en" : (navigator.language ?? "en").toLowerCase();
  return language.startsWith("sw") ? "sw" : "en";
}

const en = {
  shopLocation: "Shop location",
  captureHeading: "Delivery point",
  noLocation: "No GPS location captured yet.",
  locationCaptured: "Location captured",
  accuracy: (meters: number) => `accurate to about ${Math.round(meters)} m`,
  capture: "Capture current GPS",
  recapture: "Update GPS",
  capturing: "Getting location…",
  geolocationUnavailable: "This device cannot share its location.",
  geolocationDenied: "Location permission was refused. Allow it and try again.",
  corridor: "Corridor",
  onCorridor: (name: string, meters: number) => `${name} · ${Math.round(meters)} m off route`,
  noCorridor: "Not on any corridor yet",
  savedLocation: "Shop location saved",
  dispatch: "Corridor dispatch",
  poolsHeading: "Delivery pools",
  loading: "Loading…",
  noPools: "No corridors yet.",
  orders: (count: number) => (count === 1 ? "1 order" : `${count} orders`),
  ofTarget: (target: string) => `of ${target}`,
  noPolicy: "No dispatch policy",
  readiness: {
    ACCUMULATING: "Filling",
    DISPATCHABLE: "Can dispatch",
    DISPATCH_READY: "Ready to dispatch",
    APPROVAL_REQUIRED: "Approval required"
  } satisfies Record<CorridorPoolReadiness, string>,
  staleCount: (count: number) => `${count} need re-checking after a map change`,
  unknownWeightCount: (count: number) => `${count} with unknown weight`,
  cutoffIn: (text: string) => `Cutoff in ${text}`,
  oldestWaiting: (text: string) => `Oldest waiting ${text}`,
  unassigned: "Not on a corridor",
  unassignedDetail: (location: number, corridor: number, pending: number, orphaned: number) =>
    `${location} without GPS · ${corridor} off every corridor · ${pending} waiting intake · ${orphaned} orphaned`,
  createManifest: "Create manifest",
  vehicle: "Vehicle",
  chooseVehicle: "Choose a vehicle",
  noVehicles: "Add a vehicle before creating a manifest.",
  created: (count: number, skipped: number, planning: number) =>
    `Manifest created with ${count} orders` +
    (skipped > 0 ? ` · ${skipped} did not fit and stay pooled` : "") +
    (planning > 0 ? ` · ${planning} too heavy for this vehicle` : ""),
  manifests: "Manifests",
  noManifests: "No manifests yet.",
  manifestStatus: {
    DRAFT: "Draft",
    OPEN: "Open",
    CLOSED: "Closed",
    DEPARTED: "Departed",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled"
  } satisfies Record<ManifestStatus, string>,
  stopStatus: {
    PENDING: "Pending",
    ARRIVED: "Arrived",
    DELIVERED: "Delivered",
    FAILED: "Failed",
    SKIPPED: "Skipped"
  } satisfies Record<ManifestStopDeliveryStatus, string>,
  loadOf: (load: string, capacity: string) => `${load} of ${capacity}`,
  close: "Close manifest",
  depart: "Start route",
  cancel: "Cancel manifest",
  cancellationReasonRequired: "Enter a reason before cancelling this manifest.",
  location: "Open location",
  items: "Items",
  payOnDelivery: "Collect on delivery",
  remove: "Remove",
  arrived: "Arrived",
  delivered: "Delivered",
  failed: "Failed",
  skipped: "Skipped",
  note: "Reason",
  noteRequired: "Enter a reason for a failed or skipped delivery.",
  released: "Returned to pool",
  walkIn: "Walk-in customer",
  myDeliveries: "My deliveries",
  retry: "Try again",
  noLogisticsAccess:
    "Your role in this shop has no delivery work. Ask the owner if that should change.",
  driversUnavailable: "Could not load the drivers list, so trips cannot be assigned right now.",
  noAssignedTrips: "No deliveries assigned to you yet.",
  driver: "Driver",
  noDriver: "No driver assigned",
  driverLeft: "Driver no longer in this business",
  assignDriver: "Assign driver",
  stopsCount: (count: number) => (count === 1 ? "1 stop" : `${count} stops`),
  setup: "Delivery setup",
  setupHeading: "Set up corridor deliveries",
  setupIntro:
    "These settings belong to this business only. The owner sets them; staff who plan deliveries can view them.",
  setupProgress: (done: number, total: number) => `${done} of ${total} steps done`,
  stepDone: "Done",
  stepTodo: "To do",
  timezone: "Timezone",
  timezoneHint: "Daily cutoff and next-day delivery are worked out in this timezone.",
  timezonePlaceholder: "e.g. Africa/Nairobi",
  useDeviceTimezone: (zone: string) => `Use this device's timezone (${zone})`,
  save: "Save",
  saved: "Saved",
  policy: "Dispatch rules",
  policyName: "Rule name",
  targetLoad: "Target load (kg)",
  targetHint: "A corridor is ready to dispatch when its waiting orders reach this weight.",
  minimumLoad: "Minimum worthwhile load (kg, optional)",
  maxDiversion: "Largest detour off the road (metres)",
  cutoff: "Daily order cutoff",
  maxWait: "Longest an order may wait (hours)",
  leadDays: "Deliver how many days after ordering",
  fallbacks: "If a corridor stays under target",
  fallback: {
    TRY_SMALLER_VEHICLE: "Suggest a smaller vehicle",
    TRY_COMPATIBLE_CORRIDOR: "Suggest joining a nearby corridor",
    REQUIRE_DISPATCH_APPROVAL: "Ask a dispatcher to approve"
  } satisfies Record<DispatchFallbackAction, string>,
  savePolicy: "Save dispatch rules",
  policyVersion: (version: number) => `Version ${version}`,
  vehicles: "Vehicles",
  vehicleName: "Vehicle name",
  registration: "Registration (optional)",
  capacity: "Capacity (kg)",
  addVehicle: "Add vehicle",
  retire: "Retire",
  reactivate: "Reactivate",
  retired: "Retired",
  noVehiclesYet: "No vehicles yet.",
  corridors: "Corridors",
  corridorName: "Corridor name",
  origin: "Starts at",
  destination: "Ends at",
  routePoints: "Points along the road, start to end: latitude, longitude (one per line)",
  routeHint: "Copy points from a maps app, or drive the road and tap the GPS button at each turn.",
  addGpsPoint: "Add my current GPS point",
  addCorridor: "Add corridor",
  noCorridorsYet: "No corridors yet.",
  corridorLength: (km: string, version: number) => `${km} km · route version ${version}`,
  routeError: (reason: "format" | "range" | "too_few", line: number | null) =>
    reason === "too_few"
      ? "Add at least two points along the road."
      : reason === "range"
        ? `Line ${line}: latitude must be -90 to 90 and longitude -180 to 180.`
        : `Line ${line}: write the point as "latitude, longitude", e.g. -1.2921, 36.8219.`,
  invalidKg: (field: string) =>
    `${field}: enter kilograms such as 6000, 6,000 or 0.9 (use a dot for decimals).`,
  required: (field: string) => `${field} is required.`,
  wholeNumber: (field: string) => `${field}: enter a whole number, e.g. 72.`,
  kgEcho: (text: string) => `= ${text}`,
  ownerOnly: "Only the owner can change these settings.",
  retryLoad: "Try again",
  changedElsewhere:
    "This was already saved with different details. The latest is shown; check it and save again.",
  examplePolicyName: "Default",
  exampleVehicleName: "7-tonne truck",
  changedSinceOpened:
    "Someone else changed this since you opened it. The latest is shown; re-apply your edits and save.",
  refreshFailed: "Could not refresh. The values shown may be out of date."
};

export type FulfillmentCopy = typeof en;

const sw: FulfillmentCopy = {
  shopLocation: "Mahali pa duka",
  captureHeading: "Mahali pa kupeleka",
  noLocation: "Bado hakuna eneo la GPS.",
  locationCaptured: "Eneo limehifadhiwa",
  accuracy: (meters: number) => `usahihi wa takriban mita ${Math.round(meters)}`,
  capture: "Chukua GPS ya sasa",
  recapture: "Sasisha GPS",
  capturing: "Inatafuta eneo…",
  geolocationUnavailable: "Kifaa hiki hakiwezi kutoa eneo lake.",
  geolocationDenied: "Ruhusa ya eneo imekataliwa. Iruhusu kisha ujaribu tena.",
  corridor: "Njia",
  onCorridor: (name: string, meters: number) => `${name} · mita ${Math.round(meters)} kutoka njia`,
  noCorridor: "Bado haiko kwenye njia yoyote",
  savedLocation: "Mahali pa duka pamehifadhiwa",
  dispatch: "Usafirishaji kwa njia",
  poolsHeading: "Mizigo inayosubiri",
  loading: "Inapakia…",
  noPools: "Bado hakuna njia.",
  orders: (count: number) => (count === 1 ? "oda 1" : `oda ${count}`),
  ofTarget: (target: string) => `kati ya ${target}`,
  noPolicy: "Hakuna sera ya usafirishaji",
  readiness: {
    ACCUMULATING: "Inajaa",
    DISPATCHABLE: "Inaweza kutumwa",
    DISPATCH_READY: "Tayari kutumwa",
    APPROVAL_REQUIRED: "Inahitaji idhini"
  } satisfies Record<CorridorPoolReadiness, string>,
  staleCount: (count: number) => `${count} zinahitaji kukaguliwa upya baada ya ramani kubadilika`,
  unknownWeightCount: (count: number) => `${count} hazina uzito unaojulikana`,
  cutoffIn: (text: string) => `Muda wa mwisho baada ya ${text}`,
  oldestWaiting: (text: string) => `Ya zamani zaidi imesubiri ${text}`,
  unassigned: "Haziko kwenye njia",
  unassignedDetail: (location: number, corridor: number, pending: number, orphaned: number) =>
    `${location} bila GPS · ${corridor} nje ya njia zote · ${pending} zinasubiri kupokelewa · ${orphaned} zimepotea`,
  createManifest: "Unda orodha ya safari",
  vehicle: "Gari",
  chooseVehicle: "Chagua gari",
  noVehicles: "Ongeza gari kabla ya kuunda orodha ya safari.",
  created: (count: number, skipped: number, planning: number) =>
    `Orodha imeundwa na oda ${count}` +
    (skipped > 0 ? ` · ${skipped} hazikutosha na zimebaki zikisubiri` : "") +
    (planning > 0 ? ` · ${planning} ni nzito mno kwa gari hili` : ""),
  manifests: "Orodha za safari",
  noManifests: "Bado hakuna orodha za safari.",
  manifestStatus: {
    DRAFT: "Rasimu",
    OPEN: "Wazi",
    CLOSED: "Imefungwa",
    DEPARTED: "Imeondoka",
    COMPLETED: "Imekamilika",
    CANCELLED: "Imeghairiwa"
  } satisfies Record<ManifestStatus, string>,
  stopStatus: {
    PENDING: "Inasubiri",
    ARRIVED: "Imefika",
    DELIVERED: "Imefikishwa",
    FAILED: "Imeshindikana",
    SKIPPED: "Imerukwa"
  } satisfies Record<ManifestStopDeliveryStatus, string>,
  loadOf: (load: string, capacity: string) => `${load} kati ya ${capacity}`,
  close: "Funga orodha",
  depart: "Anza safari",
  cancel: "Ghairi orodha",
  cancellationReasonRequired: "Andika sababu kabla ya kughairi orodha hii.",
  location: "Fungua mahali",
  items: "Bidhaa",
  payOnDelivery: "Kusanya wakati wa kufikisha",
  remove: "Ondoa",
  arrived: "Imefika",
  delivered: "Imefikishwa",
  failed: "Imeshindikana",
  skipped: "Imerukwa",
  note: "Sababu",
  noteRequired: "Andika sababu ya kushindikana au kurukwa.",
  released: "Imerudishwa kusubiri",
  walkIn: "Mteja wa papo hapo",
  myDeliveries: "Safari zangu",
  retry: "Jaribu tena",
  noLogisticsAccess:
    "Jukumu lako kwenye duka hili halina kazi za usafirishaji. Muulize mmiliki kama hilo linapaswa kubadilika.",
  driversUnavailable:
    "Imeshindwa kupakia orodha ya madereva, kwa hiyo safari haziwezi kupewa madereva kwa sasa.",
  noAssignedTrips: "Bado hujapewa safari yoyote.",
  driver: "Dereva",
  noDriver: "Hakuna dereva",
  driverLeft: "Dereva hayupo tena kwenye biashara hii",
  assignDriver: "Mpe dereva",
  stopsCount: (count: number) => (count === 1 ? "kituo 1" : `vituo ${count}`),
  setup: "Mipangilio ya usafirishaji",
  setupHeading: "Andaa usafirishaji kwa njia",
  setupIntro:
    "Mipangilio hii ni ya biashara hii pekee. Mmiliki ndiye anayeiweka; wafanyakazi wanaopanga usafirishaji wanaweza kuiona.",
  setupProgress: (done: number, total: number) => `Hatua ${done} kati ya ${total} zimekamilika`,
  stepDone: "Imekamilika",
  stepTodo: "Bado",
  timezone: "Saa za eneo",
  timezoneHint: "Muda wa mwisho wa kila siku na usafirishaji wa kesho hupimwa kwa saa hizi.",
  timezonePlaceholder: "mf. Africa/Nairobi",
  useDeviceTimezone: (zone: string) => `Tumia saa za kifaa hiki (${zone})`,
  save: "Hifadhi",
  saved: "Imehifadhiwa",
  policy: "Kanuni za usafirishaji",
  policyName: "Jina la kanuni",
  targetLoad: "Mzigo lengwa (kg)",
  targetHint: "Njia iko tayari kutuma gari oda zinazosubiri zikifikia uzito huu.",
  minimumLoad: "Mzigo wa chini unaofaa (kg, si lazima)",
  maxDiversion: "Mchepuko mkubwa zaidi kutoka barabarani (mita)",
  cutoff: "Muda wa mwisho wa oda kila siku",
  maxWait: "Muda mrefu zaidi oda inaweza kusubiri (saa)",
  leadDays: "Peleka siku ngapi baada ya oda",
  fallbacks: "Njia ikibaki chini ya lengo",
  fallback: {
    TRY_SMALLER_VEHICLE: "Pendekeza gari dogo zaidi",
    TRY_COMPATIBLE_CORRIDOR: "Pendekeza kuunganisha na njia jirani",
    REQUIRE_DISPATCH_APPROVAL: "Omba idhini ya msimamizi wa usafirishaji"
  } satisfies Record<DispatchFallbackAction, string>,
  savePolicy: "Hifadhi kanuni za usafirishaji",
  policyVersion: (version: number) => `Toleo ${version}`,
  vehicles: "Magari",
  vehicleName: "Jina la gari",
  registration: "Namba ya usajili (si lazima)",
  capacity: "Uwezo wa kubeba (kg)",
  addVehicle: "Ongeza gari",
  retire: "Staafisha",
  reactivate: "Rudisha kazini",
  retired: "Limestaafu",
  noVehiclesYet: "Bado hakuna magari.",
  corridors: "Njia",
  corridorName: "Jina la njia",
  origin: "Inaanzia",
  destination: "Inaishia",
  routePoints: "Sehemu za barabara, mwanzo hadi mwisho: latitudo, longitudo (moja kwa kila mstari)",
  routeHint:
    "Nakili sehemu kutoka programu ya ramani, au endesha barabara ukibonyeza kitufe cha GPS kila kona.",
  addGpsPoint: "Ongeza eneo langu la GPS sasa",
  addCorridor: "Ongeza njia",
  noCorridorsYet: "Bado hakuna njia.",
  corridorLength: (km: string, version: number) => `km ${km} · toleo la njia ${version}`,
  routeError: (reason: "format" | "range" | "too_few", line: number | null) =>
    reason === "too_few"
      ? "Ongeza angalau sehemu mbili za barabara."
      : reason === "range"
        ? `Mstari ${line}: latitudo iwe -90 hadi 90 na longitudo -180 hadi 180.`
        : `Mstari ${line}: andika sehemu kama "latitudo, longitudo", mf. -1.2921, 36.8219.`,
  invalidKg: (field: string) =>
    `${field}: andika kilo kama 6000, 6,000 au 0.9 (tumia nukta kwa desimali).`,
  required: (field: string) => `${field} inahitajika.`,
  wholeNumber: (field: string) => `${field}: andika namba kamili, mf. 72.`,
  kgEcho: (text: string) => `= ${text}`,
  ownerOnly: "Mmiliki pekee ndiye anayeweza kubadilisha mipangilio hii.",
  retryLoad: "Jaribu tena",
  changedElsewhere:
    "Hii ilikwisha hifadhiwa kwa maelezo tofauti. Toleo jipya linaonyeshwa; likague kisha uhifadhi tena.",
  examplePolicyName: "Kawaida",
  exampleVehicleName: "Lori la tani 7",
  changedSinceOpened:
    "Mtu mwingine alibadilisha hii tangu ulipoifungua. Toleo jipya linaonyeshwa; weka mabadiliko yako tena kisha uhifadhi.",
  refreshFailed: "Imeshindwa kusasisha. Thamani zinazoonyeshwa huenda si za sasa."
};

export function fulfillmentCopy(
  language: FulfillmentLanguage = fulfillmentLanguage()
): FulfillmentCopy {
  return language === "sw" ? sw : en;
}

/** A coarse, language-neutral duration ("2d 4h", "35m") for countdowns and ages. */
export function formatDurationSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
