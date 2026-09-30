// Medreach – rule-based emergency understanding engine.
//
// Runs identically on the server and in the browser (ES module, no deps), so
// the app can still understand an emergency when there is no internet.
// When a Claude API key is configured the server upgrades this result with
// Generative AI (see server/llm.js); this engine is the always-available floor.
//
// Understands English, Hindi (Devanagari) and Hinglish (romanised Hindi),
// because that is how people in Madhya Pradesh actually describe emergencies:
// "papa ko seene mein dard hai, pasina aa raha hai".

export const SEVERITY = ['moderate', 'serious', 'critical'];

const L = (en, hi) => ({ en, hi });

// ---------------------------------------------------------------------------
// Emergency knowledge base
// ---------------------------------------------------------------------------
// required  – the hospital MUST have these live, or it cannot treat the patient
// preferred – improves outcome, used for ranking
// golden    – minutes within which definitive care matters most
export const EMERGENCIES = {
  cardiac: {
    label: L('Heart attack / chest pain', 'दिल का दौरा / सीने में दर्द'),
    icon: '❤️', base: 'critical', golden: 90,
    required: ['emergency', 'cardiology', 'icu'],
    preferred: ['cath_lab', 'ventilator', 'blood_bank'],
    keywords: [
      ['heart attack', 5], ['chest pain', 5], ['cardiac', 4], ['dil ka daura', 6], ['heart', 2],
      ['left arm', 2], ['seene', 4], ['sine me dard', 5], ['seene mein dard', 6], ['chhati', 4], ['chati', 3],
      ['सीने', 5], ['सीना', 4], ['छाती', 5], ['दिल का दौरा', 6], ['हार्ट अटैक', 6], ['दिल', 2], ['ghabrahat', 1],
      ['sweating', 1], ['pasina', 1], ['पसीना', 1],
    ],
    firstAid: {
      en: [
        'Make the person sit down and rest in a half-sitting position; loosen tight clothing.',
        'If they are not allergic, let them CHEW one 300 mg aspirin (Disprin/Ecosprin) – do not swallow whole.',
        'Do not let them walk or climb stairs. Keep them calm and warm.',
        'If they become unresponsive and are not breathing normally, start CPR immediately.',
      ],
      hi: [
        'व्यक्ति को आधा बैठाकर आराम से बैठाएँ; तंग कपड़े ढीले करें।',
        'अगर एलर्जी नहीं है, तो 300 mg एस्पिरिन (डिस्प्रिन/इकोस्प्रिन) चबाने दें – पूरी न निगलें।',
        'उन्हें चलने या सीढ़ी चढ़ने न दें। शांत और गर्म रखें।',
        'अगर वे बेहोश हो जाएँ और सामान्य साँस न लें, तो तुरंत CPR शुरू करें।',
      ],
    },
  },
  stroke: {
    label: L('Stroke / paralysis', 'लकवा / स्ट्रोक'),
    icon: '🧠', base: 'critical', golden: 270,
    required: ['emergency', 'ct_scan', 'neurology'],
    preferred: ['thrombolysis', 'icu', 'neurosurgery', 'mri'],
    keywords: [
      ['stroke', 5], ['paralysis', 5], ['paralys', 4], ['lakwa', 6], ['lakva', 6], ['लकवा', 6], ['face droop', 5],
      ['munh tedha', 6], ['muh tedha', 6], ['मुंह टेढ़ा', 6], ['मुँह टेढ़ा', 6], ['slurred', 4], ['speech', 2],
      ['bol nahi', 4], ['बोल नहीं', 4], ['one side', 3], ['ek taraf', 4], ['एक तरफ', 4], ['numb', 2], ['sunn', 3], ['सुन्न', 3],
    ],
    firstAid: {
      en: [
        'Note the exact time symptoms started – doctors need it to decide on clot-busting treatment (within 4.5 hours).',
        'Lay the person on their side with head slightly raised. Do not give food, water or medicines.',
        'Do not give aspirin – a stroke can be caused by bleeding in the brain.',
        'Stay with them and watch their breathing.',
      ],
      hi: [
        'लक्षण शुरू होने का सही समय नोट करें – डॉक्टर को थक्का घोलने के इलाज (4.5 घंटे के अंदर) के लिए यह चाहिए।',
        'व्यक्ति को करवट से लिटाएँ, सिर थोड़ा ऊँचा रखें। खाना, पानी या दवा न दें।',
        'एस्पिरिन न दें – स्ट्रोक दिमाग़ में खून बहने से भी हो सकता है।',
        'उनके पास रहें और साँस पर नज़र रखें।',
      ],
    },
  },
  trauma: {
    label: L('Road accident / serious injury', 'सड़क दुर्घटना / गंभीर चोट'),
    icon: '🚗', base: 'serious', golden: 60,
    required: ['emergency', 'trauma', 'ct_scan'],
    preferred: ['neurosurgery', 'orthopedics', 'blood_bank', 'icu'],
    keywords: [
      ['accident', 5], ['crash', 4], ['collision', 4], ['hit by', 4], ['run over', 5], ['fracture', 4], ['injury', 2],
      ['injured', 2], ['fell from', 4], ['fall from', 4], ['durghatna', 6], ['दुर्घटना', 6], ['एक्सीडेंट', 6],
      ['takkar', 5], ['टक्कर', 5], ['haddi', 3], ['हड्डी', 3], ['chot', 2], ['चोट', 2], ['bike', 1], ['truck', 1],
      ['gir gaya', 2], ['गिर गया', 2], ['गिर गई', 2], ['head injury', 5], ['sir par chot', 5], ['सिर पर चोट', 5], ['सिर में चोट', 5],
    ],
    firstAid: {
      en: [
        'Make the scene safe – switch on hazard lights and keep traffic away.',
        'Do not move the person unless there is danger (fire, traffic). Keep the head and neck in line.',
        'Press firmly on any bleeding wound with a clean cloth and keep pressing.',
        'Do not remove a helmet unless they are not breathing. Do not give water.',
      ],
      hi: [
        'जगह सुरक्षित करें – हैज़र्ड लाइट जलाएँ, ट्रैफ़िक दूर रखें।',
        'जब तक खतरा (आग, ट्रैफ़िक) न हो, घायल को न हिलाएँ। सिर और गर्दन सीधी रखें।',
        'खून बह रहे घाव पर साफ़ कपड़े से ज़ोर से दबाएँ और दबाए रखें।',
        'साँस चल रही हो तो हेलमेट न उतारें। पानी न दें।',
      ],
    },
  },
  breathing: {
    label: L('Severe breathing difficulty', 'साँस लेने में गंभीर तकलीफ़'),
    icon: '🫁', base: 'serious', golden: 60,
    required: ['emergency', 'icu'],
    preferred: ['ventilator'],
    keywords: [
      ['breathing', 3], ['breathless', 5], ['shortness of breath', 5], ['asthma', 5], ['wheez', 4], ['choking', 4],
      ['saans', 4], ['sans', 3], ['saas', 3], ['सांस', 4], ['साँस', 4], ['dama', 4], ['दमा', 5], ['dum ghut', 5], ['दम घुट', 5],
      ['oxygen', 3],
    ],
    firstAid: {
      en: [
        'Help them sit upright and lean slightly forward; open windows for fresh air.',
        'If they have an asthma inhaler, help them take 1 puff every 30–60 seconds (up to 10 puffs).',
        'If choking on food: give 5 firm back blows between the shoulder blades, then 5 abdominal thrusts.',
        'Loosen tight clothing. Keep them calm – panic makes breathing worse.',
      ],
      hi: [
        'उन्हें सीधा बैठाएँ और थोड़ा आगे झुकाएँ; ताज़ी हवा के लिए खिड़की खोलें।',
        'अगर अस्थमा इनहेलर है तो हर 30–60 सेकंड में 1 पफ़ दिलाएँ (10 पफ़ तक)।',
        'खाना अटका हो तो: कंधों के बीच 5 ज़ोरदार थपकी, फिर 5 बार पेट पर दबाव (हेमलिक)।',
        'तंग कपड़े ढीले करें। उन्हें शांत रखें – घबराहट से साँस और बिगड़ती है।',
      ],
    },
  },
  burns: {
    label: L('Burns', 'जलना'),
    icon: '🔥', base: 'serious', golden: 120,
    required: ['emergency', 'burns'],
    preferred: ['icu', 'blood_bank'],
    keywords: [
      ['burn', 5], ['fire', 3], ['scald', 5], ['acid', 5], ['cylinder blast', 6], ['jal gaya', 6], ['jal gayi', 6],
      ['jala', 3], ['जल गया', 6], ['जल गई', 6], ['जला', 4], ['जली', 4], ['aag', 4], ['आग', 4], ['tezab', 6], ['तेज़ाब', 6], ['तेजाब', 6],
      ['garam pani', 4], ['गरम पानी', 4],
    ],
    firstAid: {
      en: [
        'Cool the burn under cool (not ice-cold) running water for 20 minutes.',
        'Remove rings, watches and clothing near the burn – unless stuck to the skin.',
        'Cover loosely with clean cling film or a clean plastic bag. Do not apply toothpaste, ghee or ice.',
        'For acid: rinse with plenty of running water for at least 20 minutes.',
      ],
      hi: [
        'जले हिस्से को 20 मिनट तक ठंडे (बर्फ़ीले नहीं) बहते पानी में रखें।',
        'जले हिस्से के पास से अँगूठी, घड़ी, कपड़े हटाएँ – अगर त्वचा से चिपके न हों।',
        'साफ़ क्लिंग फ़िल्म या साफ़ प्लास्टिक से ढीला ढकें। टूथपेस्ट, घी या बर्फ़ न लगाएँ।',
        'तेज़ाब हो तो कम से कम 20 मिनट खूब बहते पानी से धोएँ।',
      ],
    },
  },
  pregnancy: {
    label: L('Pregnancy / labour emergency', 'गर्भावस्था / प्रसव आपातकाल'),
    icon: '🤰', base: 'serious', golden: 60,
    required: ['emergency', 'obstetrics'],
    preferred: ['nicu', 'blood_bank', 'icu'],
    keywords: [
      ['pregnan', 5], ['labour', 5], ['labor pain', 5], ['delivery', 4], ['contraction', 4], ['water broke', 5],
      ['garbhvati', 6], ['garbhwati', 6], ['गर्भवती', 6], ['prasav', 6], ['प्रसव', 6], ['डिलीवरी', 5], ['पेट से', 3],
      ['pani toot', 5], ['पानी टूट', 5], ['dard shuru', 2], ['bachcha hone', 5], ['बच्चा होने', 5],
    ],
    firstAid: {
      en: [
        'Let her lie on her LEFT side – this improves blood flow to the baby.',
        'Carry her mother-child card / ANC card and any reports.',
        'If the baby is being born: support the head gently, do not pull. Keep the baby warm, skin-to-skin.',
        'Heavy bleeding, fits or severe headache are danger signs – tell the hospital immediately.',
      ],
      hi: [
        'उन्हें बाईं करवट लिटाएँ – इससे बच्चे तक खून का प्रवाह बेहतर होता है।',
        'मातृ-शिशु सुरक्षा कार्ड / ANC कार्ड और रिपोर्ट साथ रखें।',
        'अगर बच्चा बाहर आ रहा हो: सिर को धीरे से सहारा दें, खींचें नहीं। बच्चे को गर्म रखें, माँ की त्वचा से लगाएँ।',
        'ज़्यादा खून बहना, दौरे या तेज़ सिरदर्द खतरे के संकेत हैं – अस्पताल को तुरंत बताएँ।',
      ],
    },
  },
  snakebite: {
    label: L('Snake bite', 'साँप का काटना'),
    icon: '🐍', base: 'critical', golden: 120,
    required: ['emergency', 'anti_venom'],
    preferred: ['icu', 'ventilator', 'dialysis'],
    keywords: [
      ['snake', 6], ['cobra', 6], ['krait', 6], ['viper', 5], ['saanp', 6], ['sanp', 6], ['saap', 5], ['सांप', 6], ['साँप', 6],
      ['नाग', 5], ['naag', 5], ['करैत', 6],
    ],
    firstAid: {
      en: [
        'Keep the person completely still and calm – movement spreads venom faster.',
        'Keep the bitten limb straight and below heart level; remove rings, bangles, tight clothes.',
        'Do NOT cut, suck, apply ice or tie a tight tourniquet. Do not go to a jhaad-phoonk healer – anti-venom is the only cure.',
        'Note the time of bite. A photo of the snake (from a safe distance) helps, but never try to catch it.',
      ],
      hi: [
        'व्यक्ति को बिल्कुल स्थिर और शांत रखें – हिलने से ज़हर तेज़ी से फैलता है।',
        'काटे हुए अंग को सीधा और दिल से नीचे रखें; अँगूठी, चूड़ी, तंग कपड़े हटाएँ।',
        'काटें नहीं, चूसें नहीं, बर्फ़ न लगाएँ, कसकर पट्टी न बाँधें। झाड़-फूँक में समय न गँवाएँ – एंटी-वेनम ही इलाज है।',
        'काटने का समय नोट करें। सुरक्षित दूरी से साँप की फ़ोटो मदद करती है, पकड़ने की कोशिश न करें।',
      ],
    },
  },
  poisoning: {
    label: L('Poisoning / pesticide / overdose', 'ज़हर / कीटनाशक / ओवरडोज़'),
    icon: '☠️', base: 'critical', golden: 60,
    required: ['emergency', 'icu'],
    preferred: ['toxicology', 'ventilator', 'dialysis'],
    keywords: [
      ['poison', 6], ['pesticide', 6], ['insecticide', 6], ['overdose', 6], ['sulphas', 6], ['kerosene', 4], ['phenyl', 4],
      ['zeher', 6], ['zehar', 6], ['jahar', 6], ['जहर', 6], ['ज़हर', 6], ['keetnashak', 6], ['कीटनाशक', 6], ['dawai kha', 3],
      ['gas leak', 4],
    ],
    firstAid: {
      en: [
        'Do NOT make the person vomit and do not give milk, salt water or oil.',
        'If they are drowsy, lay them on their side (recovery position) so they do not choke.',
        'Take the poison bottle / pesticide packet / medicine strip with you to the hospital.',
        'If poison is on skin or clothes (farm spray), remove clothes and wash skin with soap and water.',
      ],
      hi: [
        'उल्टी न करवाएँ, और दूध, नमक का पानी या तेल न पिलाएँ।',
        'अगर व्यक्ति सुस्त है, तो करवट से लिटाएँ (रिकवरी पोज़िशन) ताकि दम न घुटे।',
        'ज़हर की बोतल / कीटनाशक पैकेट / दवा की पट्टी साथ अस्पताल ले जाएँ।',
        'अगर ज़हर त्वचा या कपड़ों पर है (खेत का छिड़काव), कपड़े उतारें और साबुन-पानी से धोएँ।',
      ],
    },
  },
  seizure: {
    label: L('Seizure / fits', 'मिर्गी / दौरे'),
    icon: '⚡', base: 'serious', golden: 60,
    required: ['emergency'],
    preferred: ['neurology', 'ct_scan', 'icu'],
    keywords: [
      ['seizure', 6], ['fits', 5], ['fit aaya', 6], ['convulsion', 6], ['mirgi', 6], ['मिर्गी', 6], ['jhatke', 5], ['झटके', 5],
      ['epilep', 6], ['दौरा पड़', 4], ['daura pad', 4], ['munh se jhaag', 5], ['झाग', 4],
    ],
    firstAid: {
      en: [
        'Clear the area of hard or sharp objects; put something soft under the head.',
        'Do NOT hold them down and do NOT put anything in the mouth (no spoon, no shoe/onion to smell).',
        'Time the seizure. After jerking stops, turn them on their side.',
        'A seizure lasting more than 5 minutes is a critical emergency.',
      ],
      hi: [
        'आसपास से सख़्त या नुकीली चीज़ें हटाएँ; सिर के नीचे कुछ नरम रखें।',
        'उन्हें पकड़ें नहीं, मुँह में कुछ न डालें (चम्मच नहीं, जूता/प्याज़ सुँघाना नहीं)।',
        'दौरे का समय देखें। झटके रुकने के बाद करवट से लिटाएँ।',
        '5 मिनट से ज़्यादा चलने वाला दौरा गंभीर आपातकाल है।',
      ],
    },
  },
  bleeding: {
    label: L('Severe bleeding / deep wound', 'ज़्यादा खून बहना / गहरा घाव'),
    icon: '🩸', base: 'serious', golden: 60,
    required: ['emergency', 'blood_bank'],
    preferred: ['trauma', 'icu'],
    keywords: [
      ['bleeding', 4], ['blood', 2], ['deep cut', 5], ['wound', 3], ['stab', 5], ['khoon', 4], ['खून', 4], ['kat gaya', 4],
      ['कट गया', 4], ['गहरा घाव', 5], ['vomiting blood', 5], ['khoon ki ulti', 6], ['खून की उल्टी', 6],
    ],
    firstAid: {
      en: [
        'Press hard directly on the wound with a clean cloth. Do not lift to check – keep pressing for 10 minutes.',
        'If blood soaks through, put another cloth on top and keep pressing.',
        'Raise the injured limb above heart level if no fracture is suspected.',
        'Lay the person down and keep them warm to prevent shock.',
      ],
      hi: [
        'घाव पर साफ़ कपड़े से सीधे ज़ोर से दबाएँ। देखने के लिए न हटाएँ – 10 मिनट दबाए रखें।',
        'अगर खून कपड़े से रिस जाए तो ऊपर दूसरा कपड़ा रखें और दबाते रहें।',
        'हड्डी टूटने का शक न हो तो घायल अंग को दिल से ऊपर उठाएँ।',
        'व्यक्ति को लिटाएँ और गर्म रखें ताकि शॉक न हो।',
      ],
    },
  },
  child_fever: {
    label: L('Child with high fever / very sick child', 'तेज़ बुखार वाला / बहुत बीमार बच्चा'),
    icon: '🧒', base: 'serious', golden: 120,
    required: ['emergency', 'pediatrics'],
    preferred: ['nicu', 'icu'],
    keywords: [
      ['high fever', 4], ['fever', 2], ['bukhar', 3], ['बुखार', 3], ['tez bukhar', 4], ['तेज़ बुखार', 4], ['dengue', 4],
      ['malaria', 4], ['diarrh', 3], ['dast', 3], ['दस्त', 3], ['newborn', 4], ['navjaat', 5], ['नवजात', 5],
      ['not feeding', 4], ['doodh nahi', 4], ['दूध नहीं', 4],
    ],
    firstAid: {
      en: [
        'Remove extra clothing and sponge the child with lukewarm (not cold) water.',
        'Give paracetamol syrup in the dose written for the child\'s weight, if available.',
        'Keep giving small sips of ORS / breast milk if the child is awake.',
        'Danger signs: fits, very drowsy, not feeding, fast breathing, cold hands and feet – go immediately.',
      ],
      hi: [
        'अतिरिक्त कपड़े हटाएँ और बच्चे को गुनगुने (ठंडे नहीं) पानी से पोंछें।',
        'उपलब्ध हो तो बच्चे के वज़न के अनुसार पैरासिटामोल सिरप दें।',
        'बच्चा जागा हो तो थोड़ा-थोड़ा ORS / माँ का दूध देते रहें।',
        'खतरे के संकेत: दौरे, बहुत सुस्ती, दूध न पीना, तेज़ साँस, ठंडे हाथ-पैर – तुरंत जाएँ।',
      ],
    },
  },
  heatstroke: {
    label: L('Heat stroke', 'लू लगना'),
    icon: '🌡️', base: 'serious', golden: 60,
    required: ['emergency', 'icu'],
    preferred: ['dialysis'],
    keywords: [
      ['heat stroke', 6], ['heatstroke', 6], ['sunstroke', 6], ['loo lag', 6], ['लू लग', 6], ['लू', 3], ['dhoop', 2], ['धूप', 2],
    ],
    firstAid: {
      en: [
        'Move the person to shade or a cool room immediately.',
        'Cool fast: wet the whole body with water and fan them; put wet cloths on neck, armpits and groin.',
        'If fully awake, give sips of water or ORS. Do not give anything by mouth if drowsy.',
      ],
      hi: [
        'व्यक्ति को तुरंत छाँव या ठंडे कमरे में ले जाएँ।',
        'तेज़ी से ठंडा करें: पूरे शरीर को पानी से गीला करें और पंखा करें; गर्दन, बगल और जाँघों पर गीला कपड़ा रखें।',
        'पूरी तरह होश में हों तो पानी या ORS घूँट-घूँट दें। सुस्त हों तो मुँह से कुछ न दें।',
      ],
    },
  },
  drowning: {
    label: L('Drowning', 'डूबना'),
    icon: '🌊', base: 'critical', golden: 30,
    required: ['emergency', 'icu', 'ventilator'],
    preferred: [],
    keywords: [['drown', 6], ['doob', 6], ['डूब', 6], ['pani me gir', 5], ['पानी में गिर', 5]],
    firstAid: {
      en: [
        'Get them out of the water only if it is safe for you.',
        'If not breathing normally: give 5 rescue breaths, then start CPR (30 compressions : 2 breaths).',
        'Do not try to press water out of the stomach. Keep them warm.',
      ],
      hi: [
        'पानी से तभी निकालें जब यह आपके लिए सुरक्षित हो।',
        'अगर सामान्य साँस न ले रहे हों: 5 बार मुँह से साँस दें, फिर CPR शुरू करें (30 दबाव : 2 साँस)।',
        'पेट से पानी निकालने की कोशिश न करें। उन्हें गर्म रखें।',
      ],
    },
  },
  animal_bite: {
    label: L('Dog / animal bite', 'कुत्ते / जानवर का काटना'),
    icon: '🐕', base: 'moderate', golden: 1440,
    required: ['emergency', 'anti_rabies'],
    preferred: [],
    keywords: [
      ['dog bite', 6], ['dog bit', 6], ['monkey bite', 6], ['kutte ne', 6], ['kutta', 4], ['कुत्ते', 6], ['कुत्ता', 5],
      ['bandar', 5], ['बंदर', 5], ['animal bite', 6],
    ],
    firstAid: {
      en: [
        'Wash the wound with soap and running water for 15 minutes – this greatly reduces rabies risk.',
        'Apply an antiseptic (povidone-iodine) if available. Do not apply chilli, turmeric or oil.',
        'Anti-rabies vaccine is needed on the same day – it is free at government hospitals.',
      ],
      hi: [
        'घाव को साबुन और बहते पानी से 15 मिनट धोएँ – इससे रेबीज़ का खतरा बहुत कम होता है।',
        'उपलब्ध हो तो एंटीसेप्टिक (पोविडोन-आयोडीन) लगाएँ। मिर्च, हल्दी या तेल न लगाएँ।',
        'एंटी-रेबीज़ टीका उसी दिन लगवाना ज़रूरी है – सरकारी अस्पताल में मुफ़्त है।',
      ],
    },
  },
  collapse: {
    label: L('Sudden collapse / unconscious', 'अचानक गिरना / बेहोशी'),
    icon: '🆘', base: 'critical', golden: 30,
    required: ['emergency', 'icu'],
    preferred: ['ventilator', 'cardiology', 'ct_scan', 'neurology'],
    keywords: [
      ['unconscious', 5], ['collapsed', 5], ['collapse', 4], ['fainted', 4], ['passed out', 5], ['unresponsive', 5],
      ['behosh', 5], ['बेहोश', 5], ['hosh nahi', 5], ['होश नहीं', 5], ['gir pade', 3], ['गिर पड़े', 3],
    ],
    firstAid: {
      en: [
        'Check if they respond when you tap their shoulders and shout.',
        'If breathing normally: turn them on their side (recovery position) and keep the airway open.',
        'Check blood sugar if a glucometer is available – if low and they can swallow, give sugar/glucose.',
      ],
      hi: [
        'कंधे थपथपाकर और ज़ोर से पुकारकर देखें कि वे जवाब देते हैं या नहीं।',
        'अगर सामान्य साँस ले रहे हैं: करवट से लिटाएँ (रिकवरी पोज़िशन) और साँस का रास्ता खुला रखें।',
        'ग्लूकोमीटर हो तो शुगर जाँचें – कम हो और निगल सकें तो चीनी/ग्लूकोज़ दें।',
      ],
    },
  },
  general: {
    label: L('Medical emergency', 'चिकित्सा आपातकाल'),
    icon: '🚑', base: 'moderate', golden: 120,
    required: ['emergency'],
    preferred: ['icu'],
    keywords: [],
    firstAid: {
      en: [
        'Keep the person lying down comfortably and stay with them.',
        'If they vomit or become drowsy, turn them onto their side.',
        'Collect their medicines, prescriptions and reports to take along.',
      ],
      hi: [
        'व्यक्ति को आराम से लिटाएँ और उनके साथ रहें।',
        'अगर उल्टी हो या सुस्ती आए, तो करवट से लिटाएँ।',
        'उनकी दवाइयाँ, पर्चे और रिपोर्ट साथ ले जाने के लिए इकट्ठा करें।',
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Red flags – modifiers that escalate severity regardless of the condition
// ---------------------------------------------------------------------------
export const RED_FLAGS = {
  unconscious: {
    label: L('Unconscious / not responding', 'बेहोश / जवाब नहीं दे रहे'),
    keywords: ['unconscious', 'not responding', 'unresponsive', 'fainted', 'passed out', 'collapsed', 'behosh', 'be hosh',
      'बेहोश', 'hosh nahi', 'होश नहीं', 'hosh me nahi', 'होश में नहीं'],
  },
  not_breathing: {
    label: L('Not breathing normally', 'सामान्य साँस नहीं'),
    keywords: ['not breathing', 'no breathing', 'stopped breathing', "isn't breathing", 'saans nahi', 'sans nahi', 'saas nahi',
      'saans ruk', 'सांस नहीं', 'साँस नहीं', 'सांस रुक', 'साँस रुक', 'saans band', 'सांस बंद'],
  },
  heavy_bleeding: {
    label: L('Heavy bleeding', 'बहुत ज़्यादा खून'),
    keywords: ['heavy bleeding', 'lot of blood', 'lots of blood', 'bleeding a lot', 'bahut khoon', 'bohot khoon', 'बहुत खून',
      'खून नहीं रुक', 'khoon nahi ruk', 'khoon ruk nahi'],
  },
  head_injury: {
    label: L('Head injury', 'सिर में चोट'),
    keywords: ['head injury', 'hit his head', 'hit her head', 'head', 'sir par', 'sir me', 'sar par', 'सिर', 'सर पर'],
  },
  seizure_long: {
    label: L('Seizure longer than 5 minutes', '5 मिनट से ज़्यादा दौरा'),
    keywords: ['not stopping', 'ruk nahi', 'रुक नहीं', 'continuous fits', 'baar baar', 'बार बार'],
  },
  pregnancy_bleeding: {
    label: L('Bleeding in pregnancy', 'गर्भावस्था में खून'),
    keywords: [],
  },
};

const CHILD_WORDS = ['baby', 'child', 'kid', 'infant', 'newborn', 'toddler', 'bachcha', 'bacha', 'bachchi', 'bacche', 'bachche',
  'bache ', 'bachi ', 'बच्चा',
  'बच्चे', 'बच्ची', 'शिशु', 'navjaat', 'नवजात', 'beta ', 'beti '];
const ELDERLY_WORDS = ['old man', 'old woman', 'elderly', 'grandfather', 'grandmother', 'dada', 'dadi', 'nana', 'nani',
  'दादा', 'दादी', 'नाना', 'नानी', 'बुज़ुर्ग', 'बुजुर्ग', 'buzurg'];

// Conversational follow-up questions (the "AI asks what it needs to know").
export const FOLLOW_UPS = {
  conscious: {
    q: L('Is the person conscious and responding?', 'क्या व्यक्ति होश में है और जवाब दे रहा है?'),
    options: [
      { value: 'yes', label: L('Yes', 'हाँ') },
      { value: 'no', label: L('No', 'नहीं') },
    ],
  },
  breathing: {
    q: L('Are they breathing normally?', 'क्या वे सामान्य रूप से साँस ले रहे हैं?'),
    options: [
      { value: 'yes', label: L('Yes', 'हाँ') },
      { value: 'difficult', label: L('With difficulty', 'मुश्किल से') },
      { value: 'no', label: L('No', 'नहीं') },
    ],
  },
  age_group: {
    q: L('Age of the patient?', 'मरीज़ की उम्र?'),
    options: [
      { value: 'child', label: L('Child (<12)', 'बच्चा (<12)') },
      { value: 'adult', label: L('Adult', 'वयस्क') },
      { value: 'elderly', label: L('Elderly (60+)', 'बुज़ुर्ग (60+)') },
    ],
  },
  bleeding: {
    q: L('Is there heavy bleeding that won\'t stop?', 'क्या बहुत खून बह रहा है जो रुक नहीं रहा?'),
    options: [
      { value: 'yes', label: L('Yes', 'हाँ') },
      { value: 'no', label: L('No', 'नहीं') },
    ],
  },
};

export const CPR_STEPS = {
  en: [
    'Call 108 now and put the phone on speaker.',
    'CPR: place the heel of your hand in the centre of the chest, other hand on top.',
    'Push hard and fast – 5 cm deep, 100–120 times a minute (to the beat of "Stayin\' Alive").',
    'Do not stop until the ambulance team takes over or the person starts breathing.',
  ],
  hi: [
    'अभी 108 पर कॉल करें और फ़ोन स्पीकर पर रखें।',
    'CPR: हथेली का निचला भाग छाती के बीच में रखें, दूसरा हाथ ऊपर रखें।',
    'ज़ोर से और तेज़ दबाएँ – 5 सेमी गहरा, एक मिनट में 100–120 बार।',
    'जब तक एम्बुलेंस टीम न आ जाए या व्यक्ति साँस न लेने लगे, रुकें नहीं।',
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function normalise(text = '') {
  return ` ${String(text).toLowerCase().replace(/[.,!?;:()"'\n\r\t।]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function hasAny(text, words) {
  return words.some((w) => text.includes(w.toLowerCase()));
}

export function extractAge(text) {
  const m = text.match(/(\d{1,3})\s*(?:saal|sal|years?|yrs?|yr|y\/o|वर्ष|साल|बरस|mahine|months?|महीने)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[0].toLowerCase();
  if (/mahine|month|महीने/.test(unit)) return Math.round((n / 12) * 10) / 10;
  return n > 0 && n < 120 ? n : null;
}

// First-aid advice for these conditions assumes the patient is awake.
const CONSCIOUS_ONLY_ADVICE = new Set(['cardiac', 'breathing', 'heatstroke', 'child_fever', 'general']);

const bump = (sev, by = 1) => SEVERITY[Math.min(SEVERITY.length - 1, SEVERITY.indexOf(sev) + by)];
const maxSev = (a, b) => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b);

// ---------------------------------------------------------------------------
// Main entry: understand an emergency description
// ---------------------------------------------------------------------------
/**
 * @param {string} text        What the caller said / typed (any language)
 * @param {object} [opts]
 * @param {'en'|'hi'} [opts.lang]
 * @param {object} [opts.answers]  Follow-up answers { conscious, breathing, age_group, bleeding }
 * @param {string} [opts.hintType] Emergency type chosen from a quick chip
 */
export function triage(text, { lang = 'en', answers = {}, hintType = null } = {}) {
  const t = normalise(text);
  // "not breathing" is a red flag, not evidence of asthma – hide it from type scoring.
  let typeText = t;
  for (const kw of RED_FLAGS.not_breathing.keywords) typeText = typeText.split(kw.toLowerCase()).join(' ');

  // 1. Score every emergency type by weighted keyword hits.
  const scores = {};
  for (const [type, def] of Object.entries(EMERGENCIES)) {
    let s = 0;
    for (const [kw, w] of def.keywords) if (typeText.includes(kw.toLowerCase())) s += w;
    if (hintType === type) s += 8;
    if (s > 0) scores[type] = s;
  }
  // "dil ka daura" (heart attack) must not be read as a seizure "daura".
  if (scores.cardiac && scores.seizure && /dil ka daura|दिल का दौरा/.test(t)) delete scores.seizure;
  // Bleeding caused by an accident/fall is trauma (needs a trauma surgeon); the bleeding becomes a red flag.
  if (scores.trauma >= 4 && scores.bleeding && hintType !== 'bleeding') delete scores.bleeding;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let type = ranked.length ? ranked[0][0] : (hintType && EMERGENCIES[hintType] ? hintType : 'general');
  const topScore = ranked.length ? ranked[0][1] : 0;
  const secondScore = ranked.length > 1 ? ranked[1][1] : 0;

  // 2. Patient profile.
  const age = extractAge(t);
  let isChild = (age !== null && age < 12) || hasAny(t, CHILD_WORDS) || answers.age_group === 'child';
  const isElderly = (age !== null && age >= 60) || hasAny(t, ELDERLY_WORDS) || answers.age_group === 'elderly';
  if (answers.age_group === 'adult' || answers.age_group === 'elderly') isChild = false;

  // A vague complaint in a child is a paediatric emergency;
  // fever in an adult is a general medical emergency.
  if (isChild && type === 'general') type = 'child_fever';
  if (type === 'child_fever' && !isChild) type = 'general';

  const def = EMERGENCIES[type];
  let severity = def.base;
  const redFlags = [];

  // 3. Red flags from the text.
  const flag = (id) => { if (!redFlags.includes(id)) redFlags.push(id); };
  if (hasAny(t, RED_FLAGS.not_breathing.keywords) || answers.breathing === 'no') flag('not_breathing');
  if (hasAny(t, RED_FLAGS.unconscious.keywords) || answers.conscious === 'no') flag('unconscious');
  if (hasAny(t, RED_FLAGS.heavy_bleeding.keywords) || answers.bleeding === 'yes') flag('heavy_bleeding');
  if (type === 'trauma' && hasAny(t, RED_FLAGS.head_injury.keywords)) flag('head_injury');
  if (type === 'seizure' && hasAny(t, RED_FLAGS.seizure_long.keywords)) flag('seizure_long');
  if (type === 'pregnancy' && (hasAny(t, ['bleeding', 'khoon', 'खून', 'blood']) || answers.bleeding === 'yes')) flag('pregnancy_bleeding');

  if (redFlags.some((f) => ['not_breathing', 'unconscious', 'heavy_bleeding', 'seizure_long', 'pregnancy_bleeding'].includes(f))) {
    severity = 'critical';
  }
  if (answers.breathing === 'difficult') severity = maxSev(severity, 'serious');
  if (isElderly && ['cardiac', 'stroke', 'breathing', 'trauma', 'heatstroke', 'general', 'seizure'].includes(type)) severity = bump(severity);
  if (isChild && ['breathing', 'poisoning', 'burns', 'snakebite'].includes(type)) severity = bump(severity);

  // 4. Capabilities the destination hospital must have *right now*.
  const required = new Set(def.required);
  const preferred = new Set(def.preferred);
  if (redFlags.includes('head_injury')) { required.add('neurosurgery'); required.add('ct_scan'); }
  if (redFlags.includes('heavy_bleeding') || redFlags.includes('pregnancy_bleeding')) required.add('blood_bank');
  if (redFlags.includes('not_breathing') || redFlags.includes('unconscious')) { required.add('icu'); preferred.add('ventilator'); }
  if (isChild && type !== 'animal_bite') preferred.add('pediatrics');
  if (type === 'pregnancy') preferred.add('nicu');
  for (const c of required) preferred.delete(c);

  // 5. Confidence: how clearly the words point to one condition.
  let confidence;
  if (!topScore) confidence = hintType ? 0.7 : 0.3;
  else confidence = Math.min(0.97, 0.45 + topScore / 20 - (secondScore / Math.max(topScore, 1)) * 0.2);
  confidence = Math.round(confidence * 100) / 100;

  // 6. First aid – CPR first if not breathing / unresponsive.
  //    If unconscious, steps that assume a conscious patient ("make them sit")
  //    are replaced by unconscious-patient care.
  const pick = (d) => d.firstAid[lang] || d.firstAid.en;
  const unconscious = redFlags.includes('unconscious');
  const needsCpr = redFlags.includes('not_breathing');
  const firstAid = [
    ...(needsCpr ? CPR_STEPS[lang] || CPR_STEPS.en : []),
    ...(unconscious && !needsCpr && type !== 'collapse' ? pick(EMERGENCIES.collapse) : []),
    ...(unconscious && CONSCIOUS_ONLY_ADVICE.has(type) ? [] : pick(def)),
  ];

  // 7. What to ask next (only questions not already answered by the text).
  const followUps = [];
  if (!answers.conscious && !redFlags.includes('unconscious')) followUps.push('conscious');
  if (!answers.breathing && !redFlags.includes('not_breathing')) followUps.push('breathing');
  if (!answers.age_group && age === null && !isChild && !isElderly && type !== 'pregnancy') followUps.push('age_group');
  if (!answers.bleeding && ['trauma', 'bleeding', 'pregnancy'].includes(type)
    && !redFlags.includes('heavy_bleeding') && !redFlags.includes('pregnancy_bleeding')) followUps.push('bleeding');

  const severityScore = { moderate: 35, serious: 65, critical: 90 }[severity] + Math.min(9, redFlags.length * 3);

  return {
    engine: 'rules',
    type,
    label: def.label[lang] || def.label.en,
    icon: def.icon,
    severity,
    severityScore,
    confidence,
    golden: def.golden,
    required: [...required],
    preferred: [...preferred],
    redFlags,
    redFlagLabels: redFlags.map((f) => RED_FLAGS[f].label[lang] || RED_FLAGS[f].label.en),
    patient: { age, isChild, isElderly },
    firstAid,
    followUps,
    ambulanceType: type === 'pregnancy' && severity !== 'critical' ? 'JANANI' : severity === 'critical' ? 'ALS' : 'BLS',
    alternatives: ranked.slice(1, 3).map(([k]) => k),
    summary: buildSummary(text, type, severity, redFlags, { age, isChild, isElderly }),
  };
}

function buildSummary(text, type, severity, redFlags, patient) {
  const who = patient.age !== null ? `${patient.age}y` : patient.isChild ? 'child' : patient.isElderly ? 'elderly' : 'adult';
  const flags = redFlags.length ? ` Red flags: ${redFlags.map((f) => RED_FLAGS[f].label.en).join(', ')}.` : '';
  return `${severity.toUpperCase()} – ${EMERGENCIES[type].label.en} (${who}).${flags} Caller said: "${String(text).trim().slice(0, 200)}"`;
}
