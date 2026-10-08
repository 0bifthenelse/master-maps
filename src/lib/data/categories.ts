/**
 * One place taxonomy for the whole app. OSM tags and SIRENE NAF codes both
 * resolve to the same category id, so search ("pharmacy", "boulangerie"),
 * map icons and the dossier panel agree on what a place is, whichever source
 * described it.
 */

export type CategoryGroup =
  | "food"
  | "shop"
  | "health"
  | "emergency"
  | "lodging"
  | "transport"
  | "money"
  | "services"
  | "education"
  | "culture"
  | "religion"
  | "leisure"
  | "public"
  | "industry"
  | "agriculture"
  | "landmark";

export interface CategoryDefinition {
  id: string;
  label: string;
  group: CategoryGroup;
  /** Search words, English and French, already accent-free and lowercase. */
  terms: readonly string[];
  /** Glyph drawn in the map marker; see overlay/icons.ts. */
  glyph: string;
  /** Minimum zoom at which an unnamed or minor place of this category shows. */
  minZoom: number;
}

const C = (id: string, label: string, group: CategoryGroup, glyph: string, minZoom: number, terms: string[]): CategoryDefinition => ({ id, label, group, glyph, minZoom, terms });

export const CATEGORIES: readonly CategoryDefinition[] = [
  C("restaurant", "Restaurant", "food", "fork", 15, ["restaurant", "restaurants", "resto", "food", "eat", "diner", "manger", "brasserie", "auberge"]),
  C("fast_food", "Fast food", "food", "burger", 15.5, ["fast food", "fastfood", "burger", "kebab", "pizza", "snack", "restauration rapide"]),
  C("cafe", "Café", "food", "cup", 15.5, ["cafe", "coffee", "salon de the", "tea"]),
  C("bar", "Bar", "food", "glass", 15.5, ["bar", "pub", "bars", "tabac bar", "brasserie"]),
  C("bakery", "Bakery", "food", "bread", 15, ["bakery", "boulangerie", "patisserie", "pastry", "bread", "pain", "viennoiserie"]),
  C("butcher", "Butcher", "food", "meat", 15.5, ["butcher", "boucherie", "charcuterie", "traiteur"]),
  C("supermarket", "Supermarket", "shop", "cart", 14, ["supermarket", "supermarche", "hypermarche", "hypermarket", "grocery", "courses", "leclerc", "carrefour", "intermarche", "super u", "lidl", "aldi", "netto", "casino"]),
  C("convenience", "Convenience store", "shop", "basket", 15.5, ["convenience", "epicerie", "superette", "alimentation", "grocery", "proxi", "spar", "vival"]),
  C("greengrocer", "Greengrocer", "shop", "basket", 16, ["greengrocer", "primeur", "fruits", "legumes", "vegetables"]),
  C("wine_shop", "Wine & spirits shop", "shop", "bottle", 16, ["wine shop", "cave", "caviste", "vins", "spirits", "armagnac"]),
  C("winery", "Winery & distillery", "agriculture", "bottle", 14.5, ["winery", "domaine", "chateau", "vineyard", "vignoble", "distillery", "distillerie", "armagnac", "floc", "vin", "wine"]),
  C("farm", "Farm", "agriculture", "leaf", 16.5, ["farm", "ferme", "exploitation agricole", "agriculture", "gaec", "earl", "elevage", "producteur", "foie gras", "canard"]),
  C("pharmacy", "Pharmacy", "health", "cross", 14, ["pharmacy", "pharmacie", "drugstore", "chemist", "medicaments", "parapharmacie"]),
  C("doctor", "Doctor", "health", "stethoscope", 15.5, ["doctor", "medecin", "generaliste", "gp", "cabinet medical", "physician", "specialiste", "medical"]),
  C("dentist", "Dentist", "health", "tooth", 15.5, ["dentist", "dentiste", "chirurgien dentiste", "orthodontiste"]),
  C("nurse", "Nurse & therapist", "health", "plus", 16.5, ["nurse", "infirmier", "infirmiere", "kine", "kinesitherapeute", "physio", "physiotherapist", "osteopathe", "orthophoniste", "podologue", "sage femme", "psychologue"]),
  C("hospital", "Hospital", "emergency", "hospital", 12.5, ["hospital", "hopital", "centre hospitalier", "clinique", "clinic", "urgences", "emergency", "ch"]),
  C("veterinary", "Veterinarian", "health", "paw", 15.5, ["veterinary", "veterinaire", "vet", "veto", "clinique veterinaire"]),
  C("nursing_home", "Nursing home", "health", "home", 15, ["nursing home", "ehpad", "maison de retraite", "residence seniors", "retirement"]),
  C("laboratory", "Medical laboratory", "health", "flask", 16, ["laboratory", "laboratoire", "analyses", "biologie medicale", "labo"]),
  C("police", "Police & gendarmerie", "emergency", "shield", 13.5, ["police", "gendarmerie", "commissariat", "brigade", "gendarme"]),
  C("fire_station", "Fire station", "emergency", "flame", 13.5, ["fire station", "pompiers", "caserne", "sdis", "centre de secours", "firefighters"]),
  C("hotel", "Hotel", "lodging", "bed", 14.5, ["hotel", "hotels", "hostel", "motel", "lodging", "hebergement"]),
  C("guest_house", "Guest house & gîte", "lodging", "bed", 15.5, ["guest house", "gite", "chambre d'hotes", "chambres d hotes", "bnb", "b&b", "bed and breakfast", "location vacances", "holiday rental"]),
  C("campsite", "Campsite", "lodging", "tent", 14, ["campsite", "camping", "caravan", "aire camping car", "camper", "glamping"]),
  C("fuel", "Fuel station", "transport", "fuel", 13.5, ["fuel", "gas", "gas station", "petrol", "station service", "essence", "carburant", "diesel", "gazole", "station essence"]),
  C("charging", "EV charging", "transport", "bolt", 15, ["charging", "ev", "borne", "recharge", "electric vehicle", "charging station"]),
  C("parking", "Parking", "transport", "parking", 15.5, ["parking", "car park", "stationnement", "garer"]),
  C("car_repair", "Car repair", "transport", "wrench", 15.5, ["car repair", "garage", "mecanique", "mechanic", "carrosserie", "body shop", "controle technique", "pneus", "tyres"]),
  C("car_dealer", "Car dealer", "transport", "car", 15.5, ["car dealer", "concessionnaire", "automobile", "voitures", "occasion", "car sales"]),
  C("train_station", "Train station", "transport", "train", 12, ["train", "train station", "railway station", "gare", "sncf", "railway"]),
  C("bus_stop", "Bus stop", "transport", "bus", 16.5, ["bus", "bus stop", "arret", "autocar", "car", "liO", "lio"]),
  C("airport", "Airfield", "transport", "plane", 12, ["airport", "aerodrome", "airfield", "aeroport", "aviation"]),
  C("taxi", "Taxi & ambulance", "transport", "car", 16, ["taxi", "vtc", "ambulance", "transport sanitaire"]),
  C("bank", "Bank", "money", "bank", 15, ["bank", "banque", "credit agricole", "caisse d'epargne", "banque populaire", "credit mutuel", "bnp", "societe generale", "lcl", "la banque postale"]),
  C("atm", "ATM", "money", "cash", 16, ["atm", "cash", "distributeur", "dab", "retrait", "cash machine", "billets"]),
  C("insurance", "Insurance", "money", "umbrella", 16, ["insurance", "assurance", "assurances", "mutuelle", "groupama", "axa", "maif", "macif", "mma"]),
  C("post_office", "Post office", "public", "mail", 14.5, ["post office", "poste", "la poste", "bureau de poste", "mail", "colis", "relais poste"]),
  C("town_hall", "Town hall", "public", "flag", 13.5, ["town hall", "mairie", "hotel de ville", "city hall", "commune"]),
  C("public_service", "Public service", "public", "flag", 15, ["prefecture", "sous prefecture", "tribunal", "court", "impots", "tax office", "caf", "cpam", "pole emploi", "france travail", "france services", "conseil departemental", "administration", "service public"]),
  C("school", "School", "education", "school", 15, ["school", "ecole", "college", "lycee", "maternelle", "primaire", "elementaire", "high school", "middle school"]),
  C("university", "Higher education", "education", "school", 14.5, ["university", "universite", "iut", "campus", "inspe", "bts", "higher education", "formation"]),
  C("kindergarten", "Childcare", "education", "child", 16, ["kindergarten", "creche", "garderie", "nursery", "childcare", "assistante maternelle", "micro creche"]),
  C("driving_school", "Driving school", "education", "car", 16, ["driving school", "auto ecole", "permis"]),
  C("library", "Library", "culture", "book", 15, ["library", "bibliotheque", "mediatheque", "books"]),
  C("museum", "Museum", "culture", "museum", 13.5, ["museum", "musee", "exposition", "gallery", "galerie", "art"]),
  C("cinema", "Cinema", "culture", "film", 14.5, ["cinema", "movie", "movies", "film", "cine"]),
  C("theatre", "Theatre & venue", "culture", "mask", 14.5, ["theatre", "theater", "salle des fetes", "concert", "spectacle", "venue", "arena", "salle de spectacle"]),
  C("place_of_worship", "Church", "religion", "church", 14, ["church", "eglise", "chapelle", "chapel", "cathedrale", "cathedral", "abbaye", "abbey", "collegiale", "temple", "mosquee", "synagogue", "place of worship", "priory", "prieure"]),
  C("cemetery", "Cemetery", "religion", "grave", 15, ["cemetery", "cimetiere", "graveyard"]),
  C("attraction", "Attraction", "landmark", "star", 13, ["attraction", "tourism", "tourisme", "sightseeing", "visite", "site", "point de vue", "viewpoint", "panorama"]),
  C("castle", "Castle", "landmark", "castle", 13, ["castle", "chateau", "fort", "donjon", "tour", "tower", "bastide", "remparts", "fortified"]),
  C("monument", "Monument & heritage", "landmark", "monument", 14, ["monument", "memorial", "statue", "patrimoine", "heritage", "historic", "historique", "ruines", "ruins", "lavoir", "pigeonnier", "moulin", "windmill", "mill", "croix", "calvaire", "archaeological", "gallo romain", "villa"]),
  C("tourist_info", "Tourist information", "landmark", "info", 14, ["tourist information", "office de tourisme", "office du tourisme", "information", "tourist office", "syndicat d'initiative"]),
  C("park", "Park & garden", "leisure", "tree", 14.5, ["park", "parc", "jardin", "garden", "square", "espace vert", "jardin public", "arboretum"]),
  C("sports", "Sports facility", "leisure", "ball", 15, ["sports", "stade", "stadium", "gymnase", "gym hall", "terrain", "pitch", "rugby", "football", "tennis", "sports centre", "arenes", "fronton", "circuit", "golf", "equitation", "horse riding", "centre equestre"]),
  C("swimming_pool", "Swimming pool", "leisure", "swim", 14.5, ["swimming pool", "piscine", "baignade", "aquatic", "centre aquatique", "lake", "lac", "plage", "beach", "swim"]),
  C("fitness", "Gym & wellness", "leisure", "dumbbell", 15.5, ["gym", "fitness", "salle de sport", "musculation", "spa", "thermes", "thermal", "wellness", "yoga", "bien etre"]),
  C("playground", "Playground", "leisure", "child", 16, ["playground", "aire de jeux", "jeux"]),
  C("hairdresser", "Hairdresser", "services", "scissors", 15.5, ["hairdresser", "coiffeur", "coiffure", "barber", "barbier", "salon"]),
  C("beauty", "Beauty salon", "services", "sparkle", 16, ["beauty", "esthetique", "institut de beaute", "estheticienne", "nail", "ongles", "spa", "massage", "tatouage", "tattoo"]),
  C("laundry", "Laundry", "services", "shirt", 16, ["laundry", "laverie", "pressing", "dry cleaning", "blanchisserie"]),
  C("funeral", "Funeral services", "services", "flower", 16, ["funeral", "pompes funebres", "funerarium", "obseques"]),
  C("real_estate", "Real estate agency", "services", "key", 16, ["real estate", "immobilier", "agence immobiliere", "estate agent", "notaire immobilier"]),
  C("legal", "Lawyer & notary", "services", "scale", 16, ["lawyer", "avocat", "notaire", "notary", "huissier", "commissaire de justice", "juriste"]),
  C("accountant", "Accountant", "services", "chart", 16.5, ["accountant", "comptable", "expert comptable", "cabinet comptable", "audit"]),
  C("architect", "Architect & engineer", "services", "ruler", 16.5, ["architect", "architecte", "engineer", "ingenieur", "bureau d'etudes", "geometre", "surveyor"]),
  C("travel_agency", "Travel agency", "services", "plane", 16, ["travel agency", "agence de voyage", "voyages", "travel"]),
  C("it_media", "IT & media", "services", "chip", 16.5, ["informatique", "it", "computer", "web", "agence web", "media", "communication", "imprimerie", "printing", "telecom"]),
  C("office", "Office", "services", "briefcase", 16.5, ["office", "bureau", "entreprise", "company", "societe", "agence", "conseil", "consulting"]),
  C("contractor", "Builder & trades", "industry", "hammer", 16, ["builder", "contractor", "artisan", "batiment", "btp", "macon", "maconnerie", "plombier", "plumber", "electricien", "electrician", "menuisier", "carpenter", "charpentier", "peintre", "painter", "couvreur", "roofer", "chauffagiste", "plaquiste", "carreleur", "terrassement", "renovation"]),
  C("industry", "Industry & workshop", "industry", "factory", 15, ["industry", "industrie", "usine", "factory", "atelier", "workshop", "fabrication", "manufacture", "zone industrielle", "entrepot", "warehouse", "logistique", "transport routier"]),
  C("wholesale", "Wholesaler", "industry", "box", 16, ["wholesale", "grossiste", "negoce", "cooperative", "cooperative agricole", "materiaux", "negoce agricole"]),
  C("utility", "Utility", "industry", "bolt", 16, ["energie", "eau", "station d'epuration", "dechetterie", "recycling", "dechets", "waste", "water works", "solar", "photovoltaique"]),
  C("clothes", "Clothing store", "shop", "shirt", 15.5, ["clothes", "clothing", "vetements", "pret a porter", "mode", "fashion", "boutique"]),
  C("shoes", "Shoe store", "shop", "shoe", 16, ["shoes", "chaussures", "shoe store", "cordonnerie"]),
  C("florist", "Florist & garden", "shop", "flower", 15.5, ["florist", "fleuriste", "fleurs", "flowers", "jardinerie", "garden centre", "pepiniere", "animalerie", "pet shop"]),
  C("diy", "Hardware & DIY", "shop", "hammer", 15, ["hardware", "diy", "bricolage", "quincaillerie", "brico", "leroy merlin", "mr bricolage", "weldom", "materiaux"]),
  C("furniture", "Furniture & home", "shop", "sofa", 15.5, ["furniture", "meubles", "ameublement", "decoration", "home", "electromenager", "cuisine", "literie", "maison"]),
  C("electronics", "Electronics", "shop", "chip", 15.5, ["electronics", "electronique", "informatique", "telephone", "mobile", "hifi", "tv"]),
  C("books_news", "Books & press", "shop", "book", 15.5, ["books", "librairie", "bookshop", "presse", "maison de la presse", "newsagent", "journaux", "papeterie", "stationery", "tabac", "tobacco", "bureau de tabac"]),
  C("optician", "Optician", "shop", "glasses", 15.5, ["optician", "opticien", "optique", "lunettes", "audioprothesiste", "hearing"]),
  C("jewelry", "Jewelry", "shop", "gem", 16, ["jewelry", "jewellery", "bijouterie", "bijoux", "horlogerie", "watches"]),
  C("sports_shop", "Sports shop", "shop", "ball", 16, ["sports shop", "articles de sport", "sport", "velo", "bike shop", "cycles", "chasse", "peche", "fishing"]),
  C("gift_shop", "Gift & specialty shop", "shop", "gift", 16, ["gift", "cadeaux", "souvenirs", "jouets", "toys", "produits regionaux", "local products", "produits du terroir", "terroir", "antiquites", "antiques", "brocante", "second hand", "depot vente"]),
  C("shop", "Shop", "shop", "bag", 16, ["shop", "store", "magasin", "commerce", "boutique"]),
  C("market", "Market", "food", "basket", 15, ["market", "marche", "halle", "halles", "marche couvert"]),
  C("toilets", "Toilets", "public", "info", 17, ["toilets", "toilettes", "wc", "restroom"]),
  C("water_point", "Drinking water", "public", "drop", 17, ["drinking water", "fontaine", "eau potable", "point d'eau", "fountain"]),
  C("viewpoint", "Viewpoint & peak", "landmark", "peak", 14, ["viewpoint", "panorama", "point de vue", "peak", "sommet", "col", "colline", "hill"]),
  C("water_tower", "Water tower", "landmark", "tower", 15.5, ["water tower", "chateau d'eau", "reservoir"]),
  C("other", "Place", "services", "dot", 17, []),
];

export const CATEGORY_BY_ID: ReadonlyMap<string, CategoryDefinition> = new Map(CATEGORIES.map((category) => [category.id, category]));

export function categoryDefinition(id: string | undefined): CategoryDefinition {
  return (id === undefined ? undefined : CATEGORY_BY_ID.get(id)) ?? CATEGORY_BY_ID.get("other")!;
}

/** Neighbouring categories a browse for one of them also shows (the "Doctors" chip lists dentists too). */
const CATEGORY_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  restaurant: ["restaurant", "fast_food"],
  supermarket: ["supermarket", "convenience"],
  doctor: ["doctor", "hospital", "dentist", "nurse", "laboratory"],
  bank: ["bank", "atm"],
  hotel: ["hotel", "guest_house", "campsite"],
  fuel: ["fuel", "charging"],
  attraction: ["attraction", "castle", "monument", "museum", "viewpoint", "tourist_info"],
  castle: ["castle", "monument"],
  winery: ["winery", "wine_shop"],
};

export function categoryFamily(id: string): readonly string[] {
  return CATEGORY_FAMILIES[id] ?? [id];
}

/* ------------------------------------------------------------------ */
/*  OSM tags                                                           */
/* ------------------------------------------------------------------ */

const OSM_TAG_CATEGORY: Readonly<Record<string, string>> = {
  "amenity=restaurant": "restaurant",
  "amenity=fast_food": "fast_food",
  "amenity=food_court": "fast_food",
  "amenity=cafe": "cafe",
  "amenity=ice_cream": "cafe",
  "amenity=bar": "bar",
  "amenity=pub": "bar",
  "amenity=biergarten": "bar",
  "amenity=nightclub": "bar",
  "amenity=pharmacy": "pharmacy",
  "healthcare=pharmacy": "pharmacy",
  "amenity=doctors": "doctor",
  "healthcare=doctor": "doctor",
  "amenity=clinic": "hospital",
  "healthcare=clinic": "hospital",
  "amenity=hospital": "hospital",
  "healthcare=hospital": "hospital",
  "amenity=dentist": "dentist",
  "healthcare=dentist": "dentist",
  "healthcare=nurse": "nurse",
  "healthcare=physiotherapist": "nurse",
  "healthcare=alternative": "nurse",
  "healthcare=psychotherapist": "nurse",
  "healthcare=podiatrist": "nurse",
  "healthcare=speech_therapist": "nurse",
  "healthcare=midwife": "nurse",
  "healthcare=laboratory": "laboratory",
  "healthcare=centre": "doctor",
  "amenity=veterinary": "veterinary",
  "amenity=nursing_home": "nursing_home",
  "social_facility=nursing_home": "nursing_home",
  "amenity=social_facility": "nursing_home",
  "amenity=police": "police",
  "amenity=fire_station": "fire_station",
  "emergency=ambulance_station": "hospital",
  "emergency=defibrillator": "hospital",
  "tourism=hotel": "hotel",
  "tourism=motel": "hotel",
  "tourism=hostel": "hotel",
  "tourism=guest_house": "guest_house",
  "tourism=chalet": "guest_house",
  "tourism=apartment": "guest_house",
  "tourism=camp_site": "campsite",
  "tourism=caravan_site": "campsite",
  "amenity=fuel": "fuel",
  "amenity=charging_station": "charging",
  "amenity=parking": "parking",
  "amenity=bicycle_parking": "parking",
  "amenity=car_wash": "car_repair",
  "shop=car_repair": "car_repair",
  "shop=tyres": "car_repair",
  "shop=car": "car_dealer",
  "shop=car_parts": "car_dealer",
  "shop=motorcycle": "car_dealer",
  "railway=station": "train_station",
  "railway=halt": "train_station",
  "public_transport=station": "train_station",
  "highway=bus_stop": "bus_stop",
  "amenity=bus_station": "bus_stop",
  "aeroway=aerodrome": "airport",
  "amenity=taxi": "taxi",
  "amenity=bank": "bank",
  "amenity=atm": "atm",
  "amenity=bureau_de_change": "bank",
  "office=insurance": "insurance",
  "amenity=post_office": "post_office",
  "amenity=post_box": "post_office",
  "amenity=townhall": "town_hall",
  "office=government": "public_service",
  "amenity=courthouse": "public_service",
  "amenity=community_centre": "theatre",
  "amenity=social_centre": "public_service",
  "amenity=school": "school",
  "amenity=college": "university",
  "amenity=university": "university",
  "amenity=kindergarten": "kindergarten",
  "amenity=childcare": "kindergarten",
  "amenity=driving_school": "driving_school",
  "amenity=library": "library",
  "tourism=museum": "museum",
  "tourism=gallery": "museum",
  "amenity=arts_centre": "museum",
  "amenity=cinema": "cinema",
  "amenity=theatre": "theatre",
  "amenity=events_venue": "theatre",
  "amenity=place_of_worship": "place_of_worship",
  "building=church": "place_of_worship",
  "building=chapel": "place_of_worship",
  "building=cathedral": "place_of_worship",
  "historic=wayside_cross": "monument",
  "historic=wayside_shrine": "monument",
  "amenity=grave_yard": "cemetery",
  "landuse=cemetery": "cemetery",
  "tourism=attraction": "attraction",
  "tourism=viewpoint": "viewpoint",
  "tourism=artwork": "monument",
  "tourism=picnic_site": "park",
  "tourism=information": "tourist_info",
  "historic=castle": "castle",
  "historic=fort": "castle",
  "historic=tower": "castle",
  "historic=city_gate": "castle",
  "historic=monument": "monument",
  "historic=memorial": "monument",
  "historic=ruins": "monument",
  "historic=archaeological_site": "monument",
  "historic=manor": "castle",
  "historic=church": "place_of_worship",
  "historic=monastery": "place_of_worship",
  "man_made=windmill": "monument",
  "man_made=watermill": "monument",
  "man_made=water_tower": "water_tower",
  "man_made=tower": "water_tower",
  "man_made=wastewater_plant": "utility",
  "man_made=water_works": "utility",
  "amenity=recycling": "utility",
  "leisure=park": "park",
  "leisure=garden": "park",
  "leisure=nature_reserve": "park",
  "leisure=pitch": "sports",
  "leisure=sports_centre": "sports",
  "leisure=stadium": "sports",
  "leisure=golf_course": "sports",
  "leisure=horse_riding": "sports",
  "leisure=track": "sports",
  "leisure=swimming_pool": "swimming_pool",
  "leisure=water_park": "swimming_pool",
  "leisure=fitness_centre": "fitness",
  "amenity=spa": "fitness",
  "leisure=playground": "playground",
  "amenity=marketplace": "market",
  "amenity=toilets": "toilets",
  "amenity=drinking_water": "water_point",
  "amenity=fountain": "water_point",
  "natural=peak": "viewpoint",
  "natural=spring": "water_point",
  "shop=supermarket": "supermarket",
  "shop=convenience": "convenience",
  "shop=general": "convenience",
  "shop=greengrocer": "greengrocer",
  "shop=farm": "farm",
  "shop=bakery": "bakery",
  "shop=pastry": "bakery",
  "shop=butcher": "butcher",
  "shop=deli": "butcher",
  "shop=cheese": "greengrocer",
  "shop=seafood": "butcher",
  "shop=wine": "wine_shop",
  "shop=alcohol": "wine_shop",
  "craft=winery": "winery",
  "craft=distillery": "winery",
  "shop=hairdresser": "hairdresser",
  "shop=beauty": "beauty",
  "shop=cosmetics": "beauty",
  "shop=massage": "beauty",
  "shop=tattoo": "beauty",
  "shop=laundry": "laundry",
  "shop=dry_cleaning": "laundry",
  "shop=funeral_directors": "funeral",
  "office=estate_agent": "real_estate",
  "office=lawyer": "legal",
  "office=notary": "legal",
  "office=accountant": "accountant",
  "office=architect": "architect",
  "office=engineer": "architect",
  "shop=travel_agency": "travel_agency",
  "office=it": "it_media",
  "shop=clothes": "clothes",
  "shop=boutique": "clothes",
  "shop=fashion_accessories": "clothes",
  "shop=shoes": "shoes",
  "shop=florist": "florist",
  "shop=garden_centre": "florist",
  "shop=pet": "florist",
  "shop=hardware": "diy",
  "shop=doityourself": "diy",
  "shop=trade": "diy",
  "shop=furniture": "furniture",
  "shop=interior_decoration": "furniture",
  "shop=appliance": "furniture",
  "shop=kitchen": "furniture",
  "shop=electronics": "electronics",
  "shop=computer": "electronics",
  "shop=mobile_phone": "electronics",
  "shop=books": "books_news",
  "shop=newsagent": "books_news",
  "shop=stationery": "books_news",
  "shop=tobacco": "books_news",
  "shop=optician": "optician",
  "shop=hearing_aids": "optician",
  "shop=jewelry": "jewelry",
  "shop=sports": "sports_shop",
  "shop=bicycle": "sports_shop",
  "shop=outdoor": "sports_shop",
  "shop=gift": "gift_shop",
  "shop=toys": "gift_shop",
  "shop=antiques": "gift_shop",
  "shop=second_hand": "gift_shop",
  "shop=variety_store": "gift_shop",
};

/** Category for a set of OSM tags, the first decisive key winning. */
export function categoryForOsmTags(tags: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["amenity", "healthcare", "emergency", "shop", "tourism", "historic", "railway", "public_transport", "aeroway", "highway", "leisure", "office", "craft", "man_made", "natural", "social_facility", "landuse", "building"]) {
    const value = tags[key];
    if (typeof value !== "string" || value === "") continue;
    const found = OSM_TAG_CATEGORY[`${key}=${value}`];
    if (found !== undefined) return found;
  }
  if (typeof tags.shop === "string") return "shop";
  if (typeof tags.office === "string") return "office";
  if (typeof tags.craft === "string") return "contractor";
  if (typeof tags.historic === "string") return "monument";
  if (typeof tags.tourism === "string") return "attraction";
  return undefined;
}

/** Category for a bare OSM value as stored by the normalizer (amenity, shop... value). */
export function categoryForOsmValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  for (const key of ["amenity", "shop", "healthcare", "tourism", "historic", "leisure", "office", "craft", "man_made", "natural", "railway", "highway", "emergency", "aeroway"]) {
    const found = OSM_TAG_CATEGORY[`${key}=${value}`];
    if (found !== undefined) return found;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  SIRENE NAF codes                                                   */
/* ------------------------------------------------------------------ */

/**
 * Activities that describe a legal vehicle rather than a place someone can
 * visit: holding and property-owning companies, head offices, fund
 * management and the bulk of associations. They are kept out of the map.
 */
const NON_PLACE_NAF = new Set([
  "64.20Z", "68.20A", "68.20B", "70.10Z", "66.30Z", "64.30Z", "64.99Z", "94.99Z", "94.11Z", "94.12Z", "94.20Z", "94.92Z", "82.99Z", "99.00Z", "84.12Z", "84.13Z",
]);

const NAF_CATEGORY: Readonly<Record<string, string>> = {
  "10.71A": "bakery", "10.71B": "bakery", "10.71C": "bakery", "10.71D": "bakery", "10.13B": "butcher", "10.11Z": "industry",
  "11.01Z": "winery", "11.02A": "winery", "11.02B": "winery", "01.21Z": "winery",
  "41.20A": "contractor", "41.20B": "contractor", "43.21A": "contractor", "43.21B": "contractor", "43.22A": "contractor", "43.22B": "contractor",
  "43.29A": "contractor", "43.29B": "contractor", "43.31Z": "contractor", "43.32A": "contractor", "43.32B": "contractor", "43.32C": "contractor",
  "43.33Z": "contractor", "43.34Z": "contractor", "43.39Z": "contractor", "43.91A": "contractor", "43.91B": "contractor", "43.99A": "contractor",
  "43.99B": "contractor", "43.99C": "contractor", "43.99D": "contractor", "43.99E": "contractor", "43.11Z": "contractor", "43.12A": "contractor", "43.12B": "contractor",
  "45.11Z": "car_dealer", "45.19Z": "car_dealer", "45.20A": "car_repair", "45.20B": "car_repair", "45.31Z": "car_dealer", "45.32Z": "car_dealer", "45.40Z": "car_dealer",
  "47.11A": "convenience", "47.11B": "convenience", "47.11C": "convenience", "47.11D": "supermarket", "47.11E": "supermarket", "47.11F": "supermarket",
  "47.19A": "shop", "47.19B": "shop", "47.21Z": "greengrocer", "47.22Z": "butcher", "47.23Z": "butcher", "47.24Z": "bakery", "47.25Z": "wine_shop",
  "47.26Z": "books_news", "47.29Z": "greengrocer", "47.30Z": "fuel", "47.41Z": "electronics", "47.42Z": "electronics", "47.43Z": "electronics",
  "47.51Z": "clothes", "47.52A": "diy", "47.52B": "diy", "47.53Z": "furniture", "47.54Z": "furniture", "47.59A": "furniture", "47.59B": "furniture",
  "47.61Z": "books_news", "47.62Z": "books_news", "47.63Z": "electronics", "47.64Z": "sports_shop", "47.65Z": "gift_shop",
  "47.71Z": "clothes", "47.72A": "shoes", "47.72B": "clothes", "47.73Z": "pharmacy", "47.74Z": "pharmacy", "47.75Z": "beauty", "47.76Z": "florist",
  "47.77Z": "jewelry", "47.78A": "optician", "47.78B": "electronics", "47.78C": "gift_shop", "47.79Z": "gift_shop", "47.81Z": "market", "47.82Z": "market", "47.89Z": "market",
  "47.91A": "shop", "47.91B": "shop", "47.99A": "shop", "47.99B": "shop",
  "49.10Z": "train_station", "49.31Z": "bus_stop", "49.32Z": "taxi", "49.39A": "bus_stop", "49.39B": "bus_stop", "49.41A": "industry", "49.41B": "industry", "49.41C": "industry", "49.42Z": "industry",
  "52.10A": "industry", "52.10B": "industry", "52.21Z": "parking", "52.29A": "industry", "52.29B": "industry", "53.10Z": "post_office", "53.20Z": "post_office",
  "55.10Z": "hotel", "55.20Z": "guest_house", "55.30Z": "campsite", "55.90Z": "guest_house",
  "56.10A": "restaurant", "56.10B": "restaurant", "56.10C": "fast_food", "56.21Z": "restaurant", "56.29A": "restaurant", "56.29B": "restaurant", "56.30Z": "bar",
  "58.11Z": "it_media", "58.13Z": "it_media", "58.14Z": "it_media", "59.11A": "it_media", "59.14Z": "cinema", "60.10Z": "it_media", "62.01Z": "it_media", "62.02A": "it_media", "62.09Z": "it_media", "63.11Z": "it_media", "63.12Z": "it_media",
  "64.19Z": "bank", "64.92Z": "bank", "65.11Z": "insurance", "65.12Z": "insurance", "66.12Z": "bank", "66.19B": "bank", "66.22Z": "insurance",
  "68.10Z": "real_estate", "68.31Z": "real_estate", "68.32A": "real_estate", "68.32B": "real_estate",
  "69.10Z": "legal", "69.20Z": "accountant", "70.21Z": "office", "70.22Z": "office", "71.11Z": "architect", "71.12A": "architect", "71.12B": "architect", "71.20A": "car_repair", "71.20B": "laboratory",
  "73.11Z": "it_media", "73.12Z": "it_media", "74.10Z": "office", "74.20Z": "it_media", "74.30Z": "office", "74.90A": "office", "74.90B": "office", "75.00Z": "veterinary",
  "77.11A": "car_dealer", "77.11B": "car_dealer", "77.21Z": "sports_shop", "79.11Z": "travel_agency", "79.12Z": "travel_agency", "79.90Z": "tourist_info",
  "81.21Z": "office", "81.22Z": "office", "81.29A": "utility", "81.30Z": "florist", "82.11Z": "office",
  "84.11Z": "town_hall", "84.21Z": "public_service", "84.22Z": "public_service", "84.23Z": "public_service", "84.24Z": "police", "84.25Z": "fire_station", "84.30A": "public_service", "84.30B": "public_service", "84.30C": "public_service",
  "85.10Z": "school", "85.20Z": "school", "85.31Z": "school", "85.32Z": "school", "85.41Z": "university", "85.42Z": "university", "85.51Z": "sports", "85.52Z": "school", "85.53Z": "driving_school", "85.59A": "university", "85.59B": "university", "85.60Z": "office",
  "86.10Z": "hospital", "86.21Z": "doctor", "86.22A": "doctor", "86.22B": "doctor", "86.22C": "doctor", "86.23Z": "dentist", "86.90A": "taxi", "86.90B": "laboratory", "86.90C": "nurse", "86.90D": "nurse", "86.90E": "nurse", "86.90F": "nurse",
  "87.10A": "nursing_home", "87.10B": "nursing_home", "87.10C": "nursing_home", "87.20A": "nursing_home", "87.20B": "nursing_home", "87.30A": "nursing_home", "87.30B": "nursing_home", "87.90A": "nursing_home", "87.90B": "nursing_home",
  "88.91A": "kindergarten", "88.91B": "kindergarten", "88.10A": "public_service", "88.10B": "public_service", "88.10C": "public_service", "88.99A": "public_service", "88.99B": "public_service",
  "90.01Z": "theatre", "90.02Z": "theatre", "90.04Z": "theatre", "91.01Z": "library", "91.02Z": "museum", "91.03Z": "monument", "91.04Z": "park",
  "93.11Z": "sports", "93.12Z": "sports", "93.13Z": "fitness", "93.19Z": "sports", "93.21Z": "attraction", "93.29Z": "attraction",
  "95.11Z": "electronics", "95.12Z": "electronics", "95.21Z": "electronics", "95.22Z": "furniture", "95.23Z": "shoes", "95.24Z": "furniture", "95.25Z": "jewelry", "95.29Z": "gift_shop",
  "96.01A": "laundry", "96.01B": "laundry", "96.02A": "hairdresser", "96.02B": "beauty", "96.03Z": "funeral", "96.04Z": "fitness", "96.09Z": "beauty",
  "35.11Z": "utility", "35.12Z": "utility", "35.13Z": "utility", "35.14Z": "utility", "35.21Z": "utility", "35.30Z": "utility", "36.00Z": "utility", "37.00Z": "utility", "38.11Z": "utility", "38.21Z": "utility", "38.32Z": "utility",
};

/** Category for a section letter when the code itself is not listed. */
const NAF_SECTION_FALLBACK: Readonly<Record<string, string>> = {
  A: "farm", B: "industry", C: "industry", D: "utility", E: "utility", F: "contractor", G: "shop", H: "industry", I: "restaurant",
  J: "it_media", K: "bank", L: "real_estate", M: "office", N: "office", O: "public_service", P: "school", Q: "doctor", R: "attraction", S: "office",
};

const NAF_DIVISION_SECTION: ReadonlyArray<[number, number, string]> = [
  [1, 3, "A"], [5, 9, "B"], [10, 33, "C"], [35, 35, "D"], [36, 39, "E"], [41, 43, "F"], [45, 47, "G"], [49, 53, "H"], [55, 56, "I"],
  [58, 63, "J"], [64, 66, "K"], [68, 68, "L"], [69, 75, "M"], [77, 82, "N"], [84, 84, "O"], [85, 85, "P"], [86, 88, "Q"], [90, 93, "R"], [94, 96, "S"],
];

function nafSection(code: string): string | undefined {
  const division = Number.parseInt(code.slice(0, 2), 10);
  if (!Number.isFinite(division)) return undefined;
  return NAF_DIVISION_SECTION.find(([from, to]) => division >= from && division <= to)?.[2];
}

/** Whether a NAF code describes something people can visit. */
export function nafIsPlace(code: string | undefined): boolean {
  if (code === undefined) return true;
  return !NON_PLACE_NAF.has(code.trim().toUpperCase());
}

export function categoryForNaf(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  const normalized = code.trim().toUpperCase();
  const direct = NAF_CATEGORY[normalized];
  if (direct !== undefined) return direct;
  if (normalized.startsWith("01.") || normalized.startsWith("02.") || normalized.startsWith("03.")) return "farm";
  if (normalized.startsWith("46.")) return "wholesale";
  const section = nafSection(normalized);
  return section === undefined ? undefined : NAF_SECTION_FALLBACK[section];
}

/* ------------------------------------------------------------------ */
/*  Search intent                                                      */
/* ------------------------------------------------------------------ */

export function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’'`]/g, " ").replace(/[^a-z0-9&]+/g, " ").trim();
}

interface TermEntry {
  tokens: string[];
  category: string;
}

let termIndex: TermEntry[] | null = null;

function terms(): TermEntry[] {
  if (termIndex !== null) return termIndex;
  const entries: TermEntry[] = [];
  for (const category of CATEGORIES) {
    for (const term of [...category.terms, foldSearchText(category.label)]) {
      const tokens = foldSearchText(term).split(" ").filter(Boolean);
      if (tokens.length > 0) entries.push({ tokens, category: category.id });
    }
  }
  /* Longest phrases first so "station service" beats "station". */
  entries.sort((first, second) => second.tokens.length - first.tokens.length || second.tokens.join(" ").length - first.tokens.join(" ").length);
  termIndex = entries;
  return entries;
}

export interface CategoryIntent {
  category: string;
  /** Query tokens the category phrase consumed. */
  consumed: number[];
}

/**
 * Find the category a query asks for ("pharmacie auch", "gas near condom",
 * "restaurants"). Returns every matching category phrase so the caller can
 * strip the consumed tokens and treat the rest as a place name.
 */
export function categoryIntents(tokens: readonly string[], options: { prefix?: boolean } = {}): CategoryIntent[] {
  const found: CategoryIntent[] = [];
  const used = new Set<number>();
  /* Whole words first, so "gare" means a station before it is read as the start of "garer". */
  for (const allowPrefix of options.prefix === false ? [false] : [false, true]) {
    for (const entry of terms()) {
      for (let start = 0; start + entry.tokens.length <= tokens.length; start += 1) {
        let matches = true;
        for (let offset = 0; offset < entry.tokens.length; offset += 1) {
          const token = tokens[start + offset]!;
          const term = entry.tokens[offset]!;
          if (used.has(start + offset)) { matches = false; break; }
          const last = start + offset === tokens.length - 1;
          /* Plural tolerance ("pharmacies"), and while typing a prefix of the last word ("restau"). */
          const whole = token === term || token === `${term}s` || `${token}s` === term;
          if (!(whole || (allowPrefix && last && token.length >= 4 && term.startsWith(token)))) { matches = false; break; }
        }
        if (!matches) continue;
        const consumed = entry.tokens.map((_, offset) => start + offset);
        for (const index of consumed) used.add(index);
        if (!found.some((intent) => intent.category === entry.category)) found.push({ category: entry.category, consumed });
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/*  BD TOPO natures and free text                                      */
/* ------------------------------------------------------------------ */

function foldKey(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();
}

const BDTOPO_NATURE_CATEGORY: Readonly<Record<string, string>> = {
  "culte chretien": "place_of_worship", "culte musulman": "place_of_worship", "culte israelite": "place_of_worship", "culte divers": "place_of_worship",
  eglise: "place_of_worship", chapelle: "place_of_worship", "eglise ou chapelle": "place_of_worship", clocher: "place_of_worship",
  mairie: "town_hall", "espace public": "park", "aire de detente": "park", "enseignement primaire": "school", college: "school", lycee: "school",
  "autre etablissement d'enseignement": "school", "enseignement superieur": "university", universite: "university",
  monument: "monument", "vestige archeologique": "monument", megalithe: "monument", tombeau: "monument", calvaire: "monument", croix: "monument",
  "moulin a vent": "monument", moulin: "monument", lavoir: "monument", pigeonnier: "monument",
  "station d'epuration": "utility", "station de pompage": "utility", decheterie: "utility", "centrale electrique": "utility",
  "usine de production d'eau potable": "utility", eolienne: "utility",
  "divers industriel": "industry", "zone industrielle": "industry", usine: "industry", carriere: "industry", construction: "industry",
  poste: "post_office", "bureau ou hotel des postes": "post_office",
  stade: "sports", "centre equestre": "sports", "autre equipement sportif": "sports", "complexe sportif couvert": "sports", "sports en eaux vives": "sports",
  "equipement de cyclisme": "sports", "sports mecaniques": "sports", hippodrome: "sports", golf: "sports", "stand de tir": "sports", "sports nautiques": "sports",
  "site d'escalade": "sports",
  "centre de documentation": "library", "salle de spectacle ou conference": "theatre", "salle de danse ou de jeux": "theatre",
  "divers public ou administratif": "public_service", "siege d'epci": "public_service", "autre service deconcentre de l'etat": "public_service",
  "palais de justice": "public_service", "sous-prefecture": "public_service", prefecture: "public_service", "hotel de region": "public_service",
  "hotel de departement": "public_service", "administration centrale de l'etat": "public_service",
  "point de vue": "viewpoint", sommet: "viewpoint", colline: "viewpoint", "chateau d'eau": "water_tower", "reservoir d'eau ou chateau d'eau au sol": "water_tower",
  camping: "campsite", "hebergement de loisirs": "guest_house", "caserne de pompiers": "fire_station", gendarmerie: "police", police: "police", caserne: "police",
  "maison de retraite": "nursing_home", "structure d'accueil pour personnes handicapees": "nursing_home",
  musee: "museum", ecomusee: "museum", "office de tourisme": "tourist_info", piscine: "swimming_pool", "baignade surveillee": "swimming_pool",
  marche: "market", elevage: "farm", haras: "farm", "divers agricole": "farm", aquaculture: "farm",
  "parc de loisirs": "attraction", "parc zoologique": "attraction", "etablissement hospitalier": "hospital", hopital: "hospital",
  "etablissement thermal": "fitness", "divers commercial": "shop", chateau: "castle", "fort, blockhaus, casemate": "castle", tour: "castle",
  "gare voyageurs uniquement": "train_station", "gare voyageurs et fret": "train_station", gare: "train_station", "arret voyageurs": "train_station",
  "aire de repos ou de service": "parking", parking: "parking", "station-service": "fuel", aerodrome: "airport", cimetiere: "cemetery",
};

/** Category for a BD TOPO nature, or for a French activity label, by its words. */
export function categoryForBdtopoNature(nature: string | undefined, fallbackText?: string): string | undefined {
  if (nature !== undefined) {
    const direct = BDTOPO_NATURE_CATEGORY[foldKey(nature)];
    if (direct !== undefined) return direct;
  }
  for (const text of [fallbackText, nature]) {
    if (text === undefined) continue;
    const category = categoryForFreeText(text);
    if (category !== undefined) return category;
  }
  return undefined;
}

/**
 * Category of a free-text label. Words after the first "de / du / des" say
 * where a place is rather than what it is ("Relais de la Gare" is a restaurant
 * near the station, "Hôtel de la Poste" a hotel), unless a category phrase
 * runs across them ("Hôtel de Ville", "Station d'épuration").
 */
export function categoryForFreeText(text: string): string | undefined {
  const tokens = foldSearchText(text).split(" ").filter(Boolean);
  const particle = tokens.findIndex((token, index) => index > 0 && (token === "de" || token === "du" || token === "des" || token === "d"));
  const cut = particle < 0 ? tokens.length : particle;
  for (const intent of categoryIntents(tokens, { prefix: false })) {
    const first = intent.consumed[0]!;
    const last = intent.consumed[intent.consumed.length - 1]!;
    if (last < cut || (first < cut && intent.consumed.length > 1)) return intent.category;
  }
  return undefined;
}
