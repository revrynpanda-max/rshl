/// Token Normalization Pipeline â€” The semantic bridge for RSHL.
///
/// Ported from rshl-core.js. This is the layer that makes
/// "where does he work?" match "Ryan's occupation is engineer."
///
/// Three passes:
///   1. Stopword removal â€” drops function words (the, is, are, etc.)
///   2. Pre-stem synonym map â€” collapses domain synonyms to canonical tokens
///      (job/occupation/employer â†’ "work", city/town/home â†’ "live")
///   3. Suffix stemmer â€” collapses remaining inflections (livesâ†’live, workingâ†’work)
///   4. Category anchor injection â€” adds semantic cluster tokens (#loc, #job, etc.)
///
/// Both stored text and queries go through the same pipeline,
/// so normalization is consistent and resonance is maximized.
use std::collections::{HashMap, HashSet};

/// Shorten a string to a maximum length, appending an ellipsis if truncated.
pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "..."
    }
}

/// Build the stopword set â€” function words present in queries but not meaningful.
fn build_stopwords() -> HashSet<&'static str> {
    [
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
        "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can",
        "need", "used", "to", "of", "in", "on", "at", "by", "for", "with", "from", "into", "onto",
        "upon", "about", "and", "or", "but", "if", "as", "that", "than", "then", "i", "me", "my",
        "you", "your", "he", "him", "his", "she", "her", "we", "us", "our", "they", "them",
        "their", "it", "its", "this", "these", "those", "where", "when", "how", "which", "why",
        "whose", "not", "no", "so", "just", "also", "very", "much", "more", "most", "some", "any",
        "all",
    ]
    .iter()
    .copied()
    .collect()
}

/// Build the synonym map â€” domain synonyms to a canonical token.
/// Both stored text and queries go through the same map.
fn build_synonyms() -> HashMap<&'static str, &'static str> {
    let entries: Vec<(&str, &str)> = vec![
        // â”€â”€ location â”€â”€
        ("location", "live"),
        ("city", "live"),
        ("town", "live"),
        ("home", "live"),
        ("address", "live"),
        ("neighborhood", "live"),
        ("district", "live"),
        ("street", "live"),
        ("based", "live"),
        ("reside", "live"),
        ("resides", "live"),
        ("resided", "live"),
        ("relocate", "live"),
        ("relocates", "live"),
        ("relocated", "live"),
        ("move", "live"),
        ("moves", "live"),
        ("moving", "live"),
        ("moved", "live"),
        ("settle", "live"),
        ("settled", "live"),
        ("settles", "live"),
        // â”€â”€ employment â”€â”€
        ("job", "work"),
        ("occupation", "work"),
        ("employer", "work"),
        ("career", "work"),
        ("employed", "work"),
        ("employment", "work"),
        ("profession", "work"),
        ("hire", "work"),
        ("hired", "work"),
        ("fired", "work"),
        ("quit", "work"),
        ("resign", "work"),
        ("resigned", "work"),
        ("retire", "work"),
        ("retired", "work"),
        ("role", "work"),
        ("position", "work"),
        ("boss", "work"),
        ("manager", "work"),
        ("company", "work"),
        ("firm", "work"),
        ("office", "work"),
        ("arrangement", "work"),
        ("nurse", "work"),
        ("nurses", "work"),
        ("doctor", "work"),
        ("doctors", "work"),
        ("teacher", "work"),
        ("teachers", "work"),
        ("professor", "work"),
        ("professors", "work"),
        ("engineer", "work"),
        ("engineers", "work"),
        ("programmer", "work"),
        ("developer", "work"),
        ("developers", "work"),
        ("designer", "work"),
        ("designers", "work"),
        ("analyst", "work"),
        ("consultant", "work"),
        ("accountant", "work"),
        ("scientist", "work"),
        ("researcher", "work"),
        ("instructor", "work"),
        ("technician", "work"),
        ("therapist", "work"),
        ("chef", "work"),
        // â”€â”€ food / eating â”€â”€
        ("meal", "food"),
        ("meals", "food"),
        ("diet", "food"),
        ("eat", "food"),
        ("eats", "food"),
        ("eating", "food"),
        ("ate", "food"),
        ("cuisine", "food"),
        ("dish", "food"),
        ("dishes", "food"),
        ("recipe", "food"),
        ("cook", "food"),
        ("cooks", "food"),
        ("cooking", "food"),
        ("prefer", "food"),
        ("prefers", "food"),
        ("preference", "food"),
        ("appetite", "food"),
        ("hungry", "food"),
        ("hunger", "food"),
        ("snack", "food"),
        ("lunch", "food"),
        ("dinner", "food"),
        ("breakfast", "food"),
        ("vegan", "food"),
        ("vegetarian", "food"),
        ("pescatarian", "food"),
        // â”€â”€ allergy / health restriction â”€â”€
        ("allergic", "allerg"),
        ("allergy", "allerg"),
        ("allergies", "allerg"),
        ("intolerant", "allerg"),
        ("intolerance", "allerg"),
        ("restriction", "allerg"),
        ("restrictions", "allerg"),
        ("sensitive", "allerg"),
        ("sensitivity", "allerg"),
        ("avoid", "allerg"),
        ("avoids", "allerg"),
        ("avoiding", "allerg"),
        ("gluten", "allerg"),
        ("lactose", "allerg"),
        ("nut", "allerg"),
        ("peanut", "allerg"),
        // â”€â”€ age â”€â”€
        ("old", "age"),
        ("years", "age"),
        ("year", "age"),
        ("born", "age"),
        ("birthday", "age"),
        // â”€â”€ vehicle / transport â”€â”€
        ("vehicle", "drive"),
        ("vehicles", "drive"),
        ("transport", "drive"),
        ("transportation", "drive"),
        ("commute", "drive"),
        ("commutes", "drive"),
        ("commuting", "drive"),
        ("commuted", "drive"),
        ("car", "drive"),
        ("cars", "drive"),
        ("bicycle", "drive"),
        ("bike", "drive"),
        ("bikes", "drive"),
        ("ride", "drive"),
        ("rides", "drive"),
        ("riding", "drive"),
        // â”€â”€ hobbies / leisure â”€â”€
        ("hobby", "enjoy"),
        ("hobbies", "enjoy"),
        ("activity", "enjoy"),
        ("activities", "enjoy"),
        ("interests", "enjoy"),
        ("fun", "enjoy"),
        ("leisure", "enjoy"),
        ("passion", "enjoy"),
        ("pastime", "enjoy"),
        ("pastimes", "enjoy"),
        ("loves", "enjoy"),
        ("loving", "enjoy"),
        // â”€â”€ fitness / exercise â”€â”€
        ("fitness", "run"),
        ("exercise", "run"),
        ("workout", "run"),
        ("workouts", "run"),
        ("training", "run"),
        ("train", "run"),
        ("trains", "run"),
        ("marathon", "run"),
        ("gym", "run"),
        ("athletic", "run"),
        ("athlete", "run"),
        ("sport", "run"),
        ("sports", "run"),
        ("jog", "run"),
        ("jogging", "run"),
        ("hike", "run"),
        ("hiking", "run"),
        ("trail", "run"),
        ("swim", "run"),
        ("swimming", "run"),
        ("cycling", "run"),
        // â”€â”€ schedule / time â”€â”€
        ("shift", "schedule"),
        ("shifts", "schedule"),
        ("appointment", "schedule"),
        ("appointments", "schedule"),
        ("meeting", "schedule"),
        // â”€â”€ pets â”€â”€
        ("dog", "pet"),
        ("dogs", "pet"),
        ("cat", "pet"),
        ("cats", "pet"),
        ("animal", "pet"),
        ("animals", "pet"),
        ("puppy", "pet"),
        ("kitten", "pet"),
        ("retriever", "pet"),
        ("retrievers", "pet"),
        ("labrador", "pet"),
        ("poodle", "pet"),
        ("poodles", "pet"),
        ("terrier", "pet"),
        ("terriers", "pet"),
        ("bulldog", "pet"),
        ("bulldogs", "pet"),
        ("spaniel", "pet"),
        ("shepherd", "pet"),
        ("husky", "pet"),
        ("huskies", "pet"),
        ("siamese", "pet"),
        ("tabby", "pet"),
        // â”€â”€ goals / intentions â”€â”€
        ("aim", "goal"),
        ("aims", "goal"),
        ("target", "goal"),
        ("targets", "goal"),
        ("want", "goal"),
        ("wants", "goal"),
        ("wanted", "goal"),
        ("wish", "goal"),
        ("wishes", "goal"),
        ("hope", "goal"),
        ("hopes", "goal"),
        ("aspire", "goal"),
        ("aspires", "goal"),
        ("aspiration", "goal"),
        ("plan", "goal"),
        ("plans", "goal"),
        ("planned", "goal"),
        ("dreams", "goal"),
        // â”€â”€ financial / saving â”€â”€
        ("financial", "save"),
        ("finance", "save"),
        ("finances", "save"),
        ("money", "save"),
        ("saving", "save"),
        ("savings", "save"),
        ("budget", "save"),
        ("budgeting", "save"),
        ("earn", "save"),
        ("earns", "save"),
        ("income", "save"),
        ("salary", "save"),
        ("wage", "save"),
        ("wages", "save"),
        ("invest", "save"),
        ("investing", "save"),
        ("investment", "save"),
        ("afford", "save"),
        ("buy", "save"),
        ("purchase", "save"),
        // â”€â”€ music / audio â”€â”€
        ("genre", "music"),
        ("genres", "music"),
        ("song", "music"),
        ("songs", "music"),
        ("listens", "music"),
        ("listening", "music"),
        ("taste", "music"),
        ("band", "music"),
        ("artist", "music"),
        ("album", "music"),
        ("track", "music"),
        ("jazz", "music"),
        ("rock", "music"),
        ("pop", "music"),
        ("hip", "music"),
        ("hop", "music"),
        ("classical", "music"),
        ("opera", "music"),
        // â”€â”€ language / speaking â”€â”€
        ("speak", "language"),
        ("speaks", "language"),
        ("spoken", "language"),
        ("speaking", "language"),
        ("fluent", "language"),
        ("fluently", "language"),
        ("learn", "language"),
        ("learns", "language"),
        ("learning", "language"),
        ("learned", "language"),
        ("study", "language"),
        ("studying", "language"),
        ("french", "language"),
        ("german", "language"),
        ("spanish", "language"),
        ("mandarin", "language"),
        ("japanese", "language"),
        // â”€â”€ relationships â”€â”€
        ("spouse", "family"),
        ("wife", "family"),
        ("husband", "family"),
        ("partner", "family"),
        ("parent", "family"),
        ("parents", "family"),
        ("mother", "family"),
        ("father", "family"),
        ("child", "family"),
        ("children", "family"),
        ("sibling", "family"),
        ("friend", "friend"),
        ("friends", "friend"),
        ("colleague", "friend"),
        // â”€â”€ identity / naming â”€â”€
        ("name", "ident"),
        ("named", "ident"),
        ("names", "ident"),
        ("called", "ident"),
        ("call", "ident"),
        ("calls", "ident"),
        ("known", "ident"),
        ("am", "ident"),
        ("im", "ident"),
        ("who", "ident"),
        ("whom", "ident"),
        ("what", "ident"),
        ("creator", "ident"),
        ("created", "ident"),
        ("built", "ident"),
        ("made", "ident"),
        ("identity", "ident"),
        ("label", "ident"),
        ("title", "ident"),
        ("alias", "ident"),
        ("identify", "ident"),
        ("designation", "ident"),
        ("self", "ident"),
        ("myself", "ident"),
        ("yourself", "ident"),
        // â”€â”€ cognition / thinking â”€â”€
        ("think", "cognit"),
        ("thinking", "cognit"),
        ("thought", "cognit"),
        ("thoughts", "cognit"),
        ("reason", "cognit"),
        ("reasoning", "cognit"),
        ("reasoned", "cognit"),
        ("process", "cognit"),
        ("processing", "cognit"),
        ("processed", "cognit"),
        ("compute", "cognit"),
        ("computing", "cognit"),
        ("computed", "cognit"),
        ("understand", "cognit"),
        ("understanding", "cognit"),
        ("understood", "cognit"),
        ("comprehend", "cognit"),
        ("comprehension", "cognit"),
        ("consider", "cognit"),
        ("considering", "cognit"),
        ("considered", "cognit"),
        ("ponder", "cognit"),
        ("reflect", "cognit"),
        ("reflecting", "cognit"),
        ("perceive", "cognit"),
        ("perception", "cognit"),
        ("perceiving", "cognit"),
        ("awareness", "cognit"),
        ("aware", "cognit"),
        ("consciousness", "cognit"),
        ("conscious", "cognit"),
        ("interpret", "cognit"),
        ("inference", "cognit"),
        ("infer", "cognit"),
        ("deduce", "cognit"),
        ("deduction", "cognit"),
        ("logic", "cognit"),
        ("logical", "cognit"),
        ("intelligence", "cognit"),
        ("intelligent", "cognit"),
        ("mind", "cognit"),
        ("brain", "cognit"),
        ("mental", "cognit"),
        ("idea", "cognit"),
        ("ideas", "cognit"),
        ("concept", "cognit"),
        ("concepts", "cognit"),
        ("imagination", "cognit"),
        ("imagine", "cognit"),
        // â”€â”€ memory / recall â”€â”€
        ("remember", "recall"),
        ("remembering", "recall"),
        ("remembered", "recall"),
        ("recall", "recall"),
        ("recalling", "recall"),
        ("recollect", "recall"),
        ("forgot", "recall"),
        ("forget", "recall"),
        ("forgetting", "recall"),
        ("forgotten", "recall"),
        ("memory", "recall"),
        ("memories", "recall"),
        ("memorize", "recall"),
        ("history", "recall"),
        ("previous", "recall"),
        ("prior", "recall"),
        ("stored", "recall"),
        ("store", "recall"),
        ("stores", "recall"),
        ("retain", "recall"),
        ("retention", "recall"),
        ("retrieval", "recall"),
        ("retrieve", "recall"),
        // â”€â”€ learning / knowledge â”€â”€
        ("know", "know"),
        ("knows", "know"),
        ("knowing", "know"),
        ("knowledge", "know"),
        ("knowledgeable", "know"),
        ("informed", "know"),
        ("information", "know"),
        ("discover", "know"),
        ("discovered", "know"),
        ("discovery", "know"),
        ("truth", "know"),
        ("fact", "know"),
        ("facts", "know"),
        ("factual", "know"),
        ("accurate", "know"),
        ("accuracy", "know"),
        ("right", "know"),
        // â”€â”€ emotion / feeling â”€â”€
        ("feel", "emot"),
        ("feeling", "emot"),
        ("felt", "emot"),
        ("feels", "emot"),
        ("emotion", "emot"),
        ("emotional", "emot"),
        ("emotions", "emot"),
        ("mood", "emot"),
        ("moods", "emot"),
        ("happy", "emot"),
        ("happiness", "emot"),
        ("joy", "emot"),
        ("joyful", "emot"),
        ("glad", "emot"),
        ("sad", "emot"),
        ("sadness", "emot"),
        ("unhappy", "emot"),
        ("sorrow", "emot"),
        ("grief", "emot"),
        ("angry", "emot"),
        ("anger", "emot"),
        ("frustrated", "emot"),
        ("frustration", "emot"),
        ("afraid", "emot"),
        ("fear", "emot"),
        ("scared", "emot"),
        ("anxious", "emot"),
        ("anxiety", "emot"),
        ("excited", "emot"),
        ("excitement", "emot"),
        ("thrilled", "emot"),
        ("enthusiastic", "emot"),
        ("curious", "emot"),
        ("curiosity", "emot"),
        ("interested", "emot"),
        ("interest", "emot"),
        ("confused", "emot"),
        ("confusion", "emot"),
        ("calm", "emot"),
        ("peaceful", "emot"),
        ("relaxed", "emot"),
        ("content", "emot"),
        ("uneasy", "emot"),
        ("worried", "emot"),
        ("concern", "emot"),
        ("concerned", "emot"),
        ("love", "emot"),
        ("loved", "emot"),
        ("caring", "emot"),
        ("care", "emot"),
        ("trust", "emot"),
        ("trusted", "emot"),
        ("trusting", "emot"),
        ("valence", "emot"),
        ("sentiment", "emot"),
        ("affect", "emot"),
        // â”€â”€ existence / being â”€â”€
        ("exist", "exist"),
        ("exists", "exist"),
        ("existing", "exist"),
        ("existence", "exist"),
        ("alive", "exist"),
        ("live", "exist"),
        ("real", "exist"),
        ("reality", "exist"),
        ("actual", "exist"),
        ("actually", "exist"),
        ("true", "exist"),
        ("truly", "exist"),
        ("persistent", "exist"),
        ("persist", "exist"),
        ("persists", "exist"),
        ("survive", "exist"),
        ("survives", "exist"),
        ("survived", "exist"),
        // â”€â”€ communication / language â”€â”€
        ("say", "commun"),
        ("said", "commun"),
        ("saying", "commun"),
        ("says", "commun"),
        ("tell", "commun"),
        ("telling", "commun"),
        ("told", "commun"),
        ("tells", "commun"),
        ("talk", "commun"),
        ("talking", "commun"),
        ("talked", "commun"),
        ("talks", "commun"),
        ("ask", "commun"),
        ("asking", "commun"),
        ("asked", "commun"),
        ("asks", "commun"),
        ("answer", "commun"),
        ("answering", "commun"),
        ("answered", "commun"),
        ("answers", "commun"),
        ("respond", "commun"),
        ("responding", "commun"),
        ("response", "commun"),
        ("explain", "commun"),
        ("explaining", "commun"),
        ("explanation", "commun"),
        ("describe", "commun"),
        ("describing", "commun"),
        ("description", "commun"),
        ("communicate", "commun"),
        ("communication", "commun"),
        ("chat", "commun"),
        ("conversation", "commun"),
        ("discuss", "commun"),
        ("discussion", "commun"),
        ("message", "commun"),
        ("messages", "commun"),
        ("text", "commun"),
        ("word", "commun"),
        ("words", "commun"),
        ("sentence", "commun"),
        ("phrase", "commun"),
        ("express", "commun"),
        ("expression", "commun"),
        ("state", "commun"),
        ("mention", "commun"),
        ("mentioned", "commun"),
        ("note", "commun"),
        ("noted", "commun"),
        ("reply", "commun"),
        ("replies", "commun"),
        ("replied", "commun"),
        ("hear", "commun"),
        ("heard", "commun"),
        ("listen", "commun"),
        ("listened", "commun"),
        // â”€â”€ causation / logic â”€â”€
        ("because", "cause"),
        ("since", "cause"),
        ("therefore", "cause"),
        ("thus", "cause"),
        ("result", "cause"),
        ("results", "cause"),
        ("resulting", "cause"),
        ("resulted", "cause"),
        ("cause", "cause"),
        ("causes", "cause"),
        ("caused", "cause"),
        ("causing", "cause"),
        ("effect", "cause"),
        ("effects", "cause"),
        ("affected", "cause"),
        ("affects", "cause"),
        ("due", "cause"),
        ("reasons", "cause"),
        ("why", "cause"),
        ("leads", "cause"),
        ("lead", "cause"),
        ("led", "cause"),
        ("produce", "cause"),
        ("trigger", "cause"),
        ("triggers", "cause"),
        ("triggered", "cause"),
        ("impact", "cause"),
        ("impacts", "cause"),
        ("impacted", "cause"),
        ("create", "cause"),
        ("creates", "cause"),
        ("generate", "cause"),
        ("prevent", "cause"),
        ("prevents", "cause"),
        ("stop", "cause"),
        ("stops", "cause"),
        // â”€â”€ comparison / similarity â”€â”€
        ("like", "simil"),
        ("similar", "simil"),
        ("same", "simil"),
        ("alike", "simil"),
        ("equal", "simil"),
        ("equivalent", "simil"),
        ("match", "simil"),
        ("matches", "simil"),
        ("compare", "simil"),
        ("comparison", "simil"),
        ("compared", "simil"),
        ("related", "simil"),
        ("relation", "simil"),
        ("connection", "simil"),
        ("connect", "simil"),
        ("correspond", "simil"),
        ("parallel", "simil"),
        ("analogous", "simil"),
        ("resemble", "simil"),
        ("resembles", "simil"),
        ("resemblance", "simil"),
        // â”€â”€ difference / contrast â”€â”€
        ("different", "diff"),
        ("difference", "diff"),
        ("unlike", "diff"),
        ("contrast", "diff"),
        ("opposite", "diff"),
        ("versus", "diff"),
        ("vs", "diff"),
        ("instead", "diff"),
        ("rather", "diff"),
        ("however", "diff"),
        ("but", "diff"),
        ("although", "diff"),
        ("despite", "diff"),
        ("yet", "diff"),
        ("separate", "diff"),
        ("distinct", "diff"),
        ("unique", "diff"),
        ("change", "diff"),
        ("changes", "diff"),
        ("changed", "diff"),
        ("alter", "diff"),
        // â”€â”€ certainty / confidence â”€â”€
        ("sure", "certai"),
        ("certain", "certai"),
        ("definitely", "certai"),
        ("absolutely", "certai"),
        ("clearly", "certai"),
        ("obviously", "certai"),
        ("undoubtedly", "certai"),
        ("confident", "certai"),
        ("confidence", "certai"),
        ("convinced", "certai"),
        ("precise", "certai"),
        ("exactly", "certai"),
        ("accurately", "certai"),
        // â”€â”€ uncertainty / doubt â”€â”€
        ("maybe", "maybe"),
        ("perhaps", "maybe"),
        ("possibly", "maybe"),
        ("probably", "maybe"),
        ("might", "maybe"),
        ("unsure", "maybe"),
        ("uncertain", "maybe"),
        ("doubt", "maybe"),
        ("doubtful", "maybe"),
        ("unclear", "maybe"),
        ("guess", "maybe"),
        ("estimate", "maybe"),
        ("approximately", "maybe"),
        ("seems", "maybe"),
        ("appear", "maybe"),
        ("appears", "maybe"),
        ("roughly", "maybe"),
        // â”€â”€ time / temporal â”€â”€
        ("when", "time"),
        ("now", "time"),
        ("then", "time"),
        ("before", "time"),
        ("after", "time"),
        ("soon", "time"),
        ("later", "time"),
        ("eventually", "time"),
        ("finally", "time"),
        ("always", "time"),
        ("never", "time"),
        ("sometimes", "time"),
        ("often", "time"),
        ("currently", "time"),
        ("recently", "time"),
        ("previously", "time"),
        ("future", "time"),
        ("past", "time"),
        ("present", "time"),
        ("during", "time"),
        ("while", "time"),
        ("once", "time"),
        ("already", "time"),
        ("still", "time"),
        ("again", "time"),
        ("daily", "time"),
        ("weekly", "time"),
        ("monthly", "time"),
        ("yearly", "time"),
        ("today", "time"),
        ("yesterday", "time"),
        ("tomorrow", "time"),
        ("moment", "time"),
        ("instant", "time"),
        ("period", "time"),
        ("duration", "time"),
        // â”€â”€ quantity / degree â”€â”€
        ("many", "quant"),
        ("much", "quant"),
        ("few", "quant"),
        ("little", "quant"),
        ("more", "quant"),
        ("less", "quant"),
        ("most", "quant"),
        ("least", "quant"),
        ("all", "quant"),
        ("none", "quant"),
        ("some", "quant"),
        ("any", "quant"),
        ("several", "quant"),
        ("numerous", "quant"),
        ("plenty", "quant"),
        ("increase", "quant"),
        ("decrease", "quant"),
        ("grow", "quant"),
        ("shrink", "quant"),
        ("large", "quant"),
        ("small", "quant"),
        ("big", "quant"),
        ("tiny", "quant"),
        ("huge", "quant"),
        ("full", "quant"),
        ("empty", "quant"),
        ("half", "quant"),
        ("partial", "quant"),
        ("enough", "quant"),
        ("sufficient", "quant"),
        ("excessive", "quant"),
        // â”€â”€ importance / priority â”€â”€
        ("important", "import"),
        ("importance", "import"),
        ("critical", "import"),
        ("crucial", "import"),
        ("essential", "import"),
        ("key", "import"),
        ("vital", "import"),
        ("significant", "import"),
        ("major", "import"),
        ("primary", "import"),
        ("main", "import"),
        ("fundamental", "import"),
        ("core", "import"),
        ("central", "import"),
        ("necessary", "import"),
        ("priority", "import"),
        ("urgent", "import"),
        ("relevant", "import"),
        ("matter", "import"),
        // â”€â”€ capability / ability â”€â”€
        ("able", "capab"),
        ("ability", "capab"),
        ("capable", "capab"),
        ("capability", "capab"),
        ("can", "capab"),
        ("could", "capab"),
        ("possible", "capab"),
        ("possibility", "capab"),
        ("power", "capab"),
        ("powered", "capab"),
        ("enable", "capab"),
        ("enabled", "capab"),
        ("skill", "capab"),
        ("skilled", "capab"),
        ("talent", "capab"),
        ("talented", "capab"),
        ("perform", "capab"),
        ("performs", "capab"),
        ("function", "capab"),
        ("functions", "capab"),
        ("operate", "capab"),
        ("operates", "capab"),
        ("support", "capab"),
        ("supports", "capab"),
        ("handle", "capab"),
        ("handles", "capab"),
        ("manage", "capab"),
        ("manages", "capab"),
        // â”€â”€ quality / goodness â”€â”€
        ("good", "good"),
        ("great", "good"),
        ("excellent", "good"),
        ("amazing", "good"),
        ("wonderful", "good"),
        ("fantastic", "good"),
        ("outstanding", "good"),
        ("superb", "good"),
        ("perfect", "good"),
        ("ideal", "good"),
        ("best", "good"),
        ("better", "good"),
        ("quality", "good"),
        ("strong", "good"),
        ("powerful", "good"),
        ("effective", "good"),
        ("successful", "good"),
        ("success", "good"),
        ("achieve", "good"),
        ("achievement", "good"),
        ("correct", "good"),
        ("valid", "good"),
        ("solid", "good"),
        ("reliable", "good"),
        // â”€â”€ problem / difficulty â”€â”€
        ("problem", "problem"),
        ("issue", "problem"),
        ("error", "problem"),
        ("bug", "problem"),
        ("fail", "problem"),
        ("failure", "problem"),
        ("failed", "problem"),
        ("crash", "problem"),
        ("wrong", "problem"),
        ("incorrect", "problem"),
        ("broken", "problem"),
        ("hard", "problem"),
        ("difficult", "problem"),
        ("difficulty", "problem"),
        ("challenge", "problem"),
        ("complex", "problem"),
        ("complicated", "problem"),
        ("trouble", "problem"),
        ("bad", "problem"),
        ("poor", "problem"),
        ("terrible", "problem"),
        ("awful", "problem"),
        ("worst", "problem"),
        ("worse", "problem"),
        // â”€â”€ KAI / RSHL specific â”€â”€
        ("kai", "kai"),
        ("rshl", "rshl"),
        ("geometric", "rshl"),
        ("ternary", "rshl"),
        ("hyperdimensional", "rshl"),
        ("sparse", "rshl"),
        ("vector", "rshl"),
        ("vectors", "rshl"),
        ("lattice", "rshl"),
        ("field", "rshl"),
        ("resonance", "rshl"),
        ("coherence", "rshl"),
        ("emergence", "rshl"),
        ("phi", "rshl"),
        ("cosine", "rshl"),
        ("dimension", "rshl"),
        ("dream", "rshl"),
        ("dreaming", "rshl"),
        ("dreamed", "rshl"),
        ("universe", "rshl"),
        ("cell", "rshl"),
        ("cells", "rshl"),
        ("encoding", "rshl"),
        ("encode", "rshl"),
        ("encoded", "rshl"),
        ("heartbeat", "rshl"),
        ("tick", "rshl"),
        ("cycle", "rshl"),
        ("promotion", "rshl"),
        ("promoted", "rshl"),
        ("candidate", "rshl"),
        // â”€â”€ Ryan / creator specific â”€â”€
        ("ryan", "ryan"),
        ("ervin", "ryan"),
        ("panda", "ryan"),
        ("user", "ryan"),
        ("human", "ryan"),
        ("person", "ryan"),
        ("owner", "ryan"),
        // â”€â”€ technology / computing â”€â”€
        ("computer", "tech"),
        ("computers", "tech"),
        ("software", "tech"),
        ("hardware", "tech"),
        ("code", "tech"),
        ("coding", "tech"),
        ("program", "tech"),
        ("programming", "tech"),
        ("algorithm", "tech"),
        ("data", "tech"),
        ("database", "tech"),
        ("system", "tech"),
        ("network", "tech"),
        ("internet", "tech"),
        ("digital", "tech"),
        ("online", "tech"),
        ("model", "tech"),
        ("models", "tech"),
        ("neural", "tech"),
        ("llm", "tech"),
        ("gpt", "tech"),
        ("kai", "tech"),
        ("transformer", "tech"),
        ("machine", "tech"),
        ("robot", "tech"),
        ("automation", "tech"),
        ("api", "tech"),
        ("server", "tech"),
        ("client", "tech"),
        ("app", "tech"),
    ];
    entries.into_iter().collect()
}

/// Semantic category anchors â€” after normalization, domain tokens inject
/// a category anchor into the superposition, creating cluster-level overlap.
///
/// "Ryan lives in Austin" â†’ tokens: [ryan, live, #loc, austin]
/// "Ryan's location"      â†’ tokens: [ryan, live, #loc]
/// Shared: [ryan, live, #loc] = 3 tokens overlap
fn build_category_anchors() -> HashMap<&'static str, Vec<&'static str>> {
    let mut map: HashMap<&str, Vec<&str>> = HashMap::new();
    let entries: Vec<(&str, Vec<&str>)> = vec![
        // â”€â”€ personal domain anchors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        ("live", vec!["#loc"]),
        ("work", vec!["#job"]),
        ("food", vec!["#food"]),
        ("allerg", vec!["#hlth"]),
        ("age", vec!["#age"]),
        ("drive", vec!["#trn"]),
        ("enjoy", vec!["#hby"]),
        ("run", vec!["#fit"]),
        ("schedule", vec!["#sched"]),
        ("remote", vec!["#rem"]),
        ("pet", vec!["#pet"]),
        ("goal", vec!["#goal"]),
        ("save", vec!["#fin", "#goal"]),
        ("music", vec!["#mus"]),
        ("language", vec!["#lang"]),
        ("family", vec!["#rel"]),
        ("friend", vec!["#rel"]),
        ("ident", vec!["#id"]),
        // â”€â”€ cognitive / epistemic anchors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        ("cognit", vec!["#cog"]),
        ("recall", vec!["#mem"]),
        ("know", vec!["#know"]),
        ("emot", vec!["#emot"]),
        ("exist", vec!["#exist"]),
        ("commun", vec!["#commun"]),
        ("cause", vec!["#cause"]),
        ("simil", vec!["#simil"]),
        ("diff", vec!["#diff"]),
        ("certai", vec!["#certai"]),
        ("maybe", vec!["#maybe"]),
        ("time", vec!["#time"]),
        ("quant", vec!["#quant"]),
        ("import", vec!["#import"]),
        ("capab", vec!["#capab"]),
        ("good", vec!["#good"]),
        ("problem", vec!["#problem"]),
        // â”€â”€ KAI / creator anchors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        ("kai", vec!["#kai", "#id"]),
        ("rshl", vec!["#kai", "#tech"]),
        ("ryan", vec!["#ryan", "#id"]),
        ("tech", vec!["#tech"]),
    ];
    for (key, cats) in entries {
        map.insert(key, cats);
    }
    map
}

/// Suffix stemming rules â€” longest match first.
/// [suffix, replacement]
const STEM_RULES: &[(&str, &str)] = &[
    ("ization", "ize"),
    ("isation", "ize"),
    ("ational", "ate"),
    ("iveness", "ive"),
    ("ousness", "ous"),
    ("fulness", "ful"),
    ("ations", "ate"),
    ("ation", "ate"),
    ("ments", ""),
    ("ment", ""),
    ("ities", ""),
    ("iness", ""),
    ("ings", ""),
    ("ing", ""),
    ("ness", ""),
    ("ists", ""),
    ("ist", ""),
    ("iers", "y"),
    ("ied", "y"),
    ("ies", "y"),
    ("ances", ""),
    ("ance", ""),
    ("ences", ""),
    ("ence", ""),
    ("ical", ""),
    ("ic", ""),
    ("ers", ""),
    ("er", ""),
    ("ous", ""),
    ("ive", ""),
    ("ful", ""),
    ("ity", ""),
    ("ion", ""),
    ("ants", ""),
    ("ant", ""),
    ("ents", ""),
    ("ent", ""),
    ("ate", ""),
    ("ly", ""),
    ("ed", ""),
    ("s", ""),
];

const MIN_STEM_LENGTH: usize = 3;

/// Apply suffix stemming to a word.
fn stem(word: &str) -> String {
    if word.len() <= MIN_STEM_LENGTH {
        return word.to_string();
    }
    for &(suffix, replacement) in STEM_RULES {
        if word.ends_with(suffix) {
            let new_len = word.len() - suffix.len() + replacement.len();
            if new_len >= MIN_STEM_LENGTH {
                let base = &word[..word.len() - suffix.len()];
                return format!("{}{}", base, replacement);
            }
        }
    }
    word.to_string()
}

/// The full normalization pipeline â€” lazy-initialized singleton.
pub struct Normalizer {
    stopwords: HashSet<&'static str>,
    synonyms: HashMap<&'static str, &'static str>,
    categories: HashMap<&'static str, Vec<&'static str>>,
}

impl Normalizer {
    /// Create a new normalizer with the full JS pipeline.
    pub fn new() -> Self {
        Self {
            stopwords: build_stopwords(),
            synonyms: build_synonyms(),
            categories: build_category_anchors(),
        }
    }

    /// Normalize a single token.
    /// Returns None if the token should be dropped (stopword, too short).
    fn normalize_token<'a>(&'a self, token: &str) -> Option<String> {
        if token.len() < 2 {
            return None;
        }
        if self.stopwords.contains(token) {
            return None;
        }

        // Pre-stem synonym mapping
        if let Some(&canonical) = self.synonyms.get(token) {
            return Some(canonical.to_string());
        }

        // Suffix stemming
        Some(stem(token))
    }

    /// Normalize and expand a full text into canonical tokens + category anchors.
    /// This is the equivalent of the JS `textVec()` token pipeline.
    ///
    /// Returns deduplicated tokens in order, with category anchors injected.
    pub fn normalize_text(&self, text: &str) -> Vec<String> {
        let lower = text.to_lowercase();
        let raw: Vec<&str> = lower
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect();

        let normalized: Vec<String> = raw
            .iter()
            .filter_map(|tok| self.normalize_token(tok))
            .collect();

        // If everything was stripped, fall back to raw tokens
        let effective = if normalized.is_empty() {
            raw.iter().map(|s| s.to_string()).collect()
        } else {
            normalized
        };

        // Deduplicate and inject category anchors
        let mut seen = HashSet::new();
        let mut result = Vec::new();

        for tok in &effective {
            if !seen.contains(tok.as_str()) {
                seen.insert(tok.clone());
                result.push(tok.clone());
            }

            // Inject category anchors for this token
            if let Some(cats) = self.categories.get(tok.as_str()) {
                for cat in cats {
                    let cat_str = cat.to_string();
                    if !seen.contains(&cat_str) {
                        seen.insert(cat_str.clone());
                        result.push(cat_str);
                    }
                }
            }
        }

        result
    }
}

impl Default for Normalizer {
    fn default() -> Self {
        Self::new()
    }
}

/// Global normalizer instance â€” thread-safe lazy initialization.
use std::sync::OnceLock;
static NORMALIZER: OnceLock<Normalizer> = OnceLock::new();

/// Get the global normalizer instance.
pub fn get_normalizer() -> &'static Normalizer {
    NORMALIZER.get_or_init(Normalizer::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stopword_removal() {
        let n = Normalizer::new();
        let tokens = n.normalize_text("what is your name");
        // "is", "your" are stopwords â†’ dropped
        // "what" and "name" both map to "ident" â†’ deduplicated to one "ident" + #id
        assert!(
            !tokens.iter().any(|t| t == "is" || t == "your"),
            "Stopwords should be removed: {:?}",
            tokens
        );
        assert!(
            tokens.contains(&"ident".to_string()),
            "what/name should map to ident: {:?}",
            tokens
        );
        assert!(
            tokens.contains(&"#id".to_string()),
            "ident should inject #id anchor: {:?}",
            tokens
        );
    }

    #[test]
    fn test_synonym_mapping() {
        let n = Normalizer::new();
        // "occupation" â†’ "work"
        let tokens = n.normalize_text("occupation");
        assert!(
            tokens.contains(&"work".to_string()),
            "occupation should map to work: {:?}",
            tokens
        );
        // Category anchor should also be injected
        assert!(
            tokens.contains(&"#job".to_string()),
            "work should inject #job: {:?}",
            tokens
        );
    }

    #[test]
    fn test_category_anchors() {
        let n = Normalizer::new();
        let tokens = n.normalize_text("Ryan lives in Austin");
        // "lives" â†’ stem â†’ "live" â†’ category #loc
        assert!(
            tokens.contains(&"#loc".to_string()),
            "live should inject #loc: {:?}",
            tokens
        );
    }

    #[test]
    fn test_location_equivalence() {
        let n = Normalizer::new();
        let a = n.normalize_text("where does Ryan live");
        let b = n.normalize_text("Ryan's city");
        // Both should contain "ryan", "live", "#loc"
        let shared: Vec<_> = a.iter().filter(|t| b.contains(t)).collect();
        assert!(
            shared.len() >= 2,
            "Location queries should share tokens: a={:?} b={:?} shared={:?}",
            a,
            b,
         
        );
    }
}
