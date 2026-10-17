export const projects = [
  {
    id: 2,
    name: "QR Code Art",
    thumbnail: "/images/thumbnail_tarot_400x280.png",
    description: "Visual QR code experiments.",
    longDescription: "i ultimately went to a printer service, put this on nice business card, and gave this to the cute clinic concierge girl i met in korea. it contains the code to my kakaotalk (which i never use) and i wanted to hang out with her since i was no longer a patient, but it didnt lead to anything. kind sad.\n",
    type: "visual",
    link: "https://imgur.com/a/ai-business-card-concept-r3WrRoB"
  },
  {
    id: 3,
    name: "AI in Preconstruction Slidedeck",
    thumbnail: "/images/thumbnail_preconstruction_400x200.png",
    description: "Shared Learnings Presentation",
    longDescription: "made this when i was working as an estimator. showcases how i integrated llms into my workflow and shared with the team. ",
    type: "slides",
    link: "https://docs.google.com/presentation/d/16V3d2PMUx710QYUtwwOIYrlGYtbp2nFo/edit?usp=sharing&ouid=100373252258836087176&rtpof=true&sd=true"
  },
  {
    id: 4,
    name: "Hunter x Hunter Chapter 351 Animation",
    thumbnail: "/images/thumbnail_anime_400x280.png",
    description: "Video experiments and edits.",
    longDescription: "goal was to recreate the fight between hisoka and chrollo. doing the fight scenes is tricky i havent figured out how to get it right yet. WIP",
    type: "video",
    link: "https://youtu.be/AXULKTumiHE?si=-J7nNyww7O5ydFp9"
  },
  {
    id: 5,
    name: "Sigil Tutorial",
    thumbnail: "/images/thumbnail_face_400x280.png",
    description: "30-second looping video for TikTok/Reels/Shorts.",
    longDescription: "this was part of an ai influencer project that i didn't pursue because the tech is so damned good already and it seems like there are people who figured out how to giga scale this type of stuff. \n\nthe video is a spin on phil hine's chaos magic sigil technique. \n",
    type: "video",
    link: "https://www.instagram.com/p/DUFWRwrk-EP/"
  },
  {
    id: 6,
    name: "Maui Manifesto: A bureaucratic fairy tale",
    thumbnail: "/images/thumbnail_manifesto_400x200.png",
    description: "Short Fictional Story",
    longDescription: "inspired by the DOGE office federal cuts. i wrote this when i was really stressed studying for my NCEES PE 8hr exam. i passed the exam and got licensed as a civil PE in the state of hawaii (PE-21807-0), but let it expire in april 2026. ",
    type: "writing",
    link: "https://docs.google.com/document/d/1AsiWM508LESZ6OvDDUjtbT45pn-Qp0Na/edit?usp=sharing&ouid=100373252258836087176&rtpof=true&sd=true"
  },
  {
    id: 7,
    name: "Apothecary's Assembly",
    thumbnail: "/images/thumbnail_apothecary_400x280.png",
    description: "Party Concept + Invitation",
    longDescription: "this was originally called \"stink party\". \n\ninspired by study (https://www.mdpi.com/2077-0383/10/23/5532) that showed zinc acetate + chlorhexidine diacetate mouthwash and tongue scraping were effective measures against bad breath. wanted to do a mini replication study with group of friends.\n\nfigured smelling people's breath and just having stink stuff like rotting meat would be a neat party concept but it got shot down so i just let it die haha.",
    type: "other",
    link: "https://docs.google.com/presentation/d/1kQsK6Dfi50-dGo0NHlD0Sgru255LrMLi/edit?usp=sharing&ouid=100373252258836087176&rtpof=true&sd=true"
  }
  ,{
    id: 8,
    name: "SIOR Classification Taxonomy",
    thumbnail: "/images/sior-taxonomy.svg",
    description: "A proposed revision of Honolulu's SIOR qualification taxonomy.",
    longDescription: "i was asked to help update the city and county of honolulu's SIOR qualification checklist for IBC 2024. i pulled out the load-bearing code excerpts, organized them into a new classification taxonomy, and proposed minimum qualification requirements using the existing IBC 2018-based matrix as precedent.",
    type: "taxonomy",
    link: "https://docs.google.com/spreadsheets/d/1JaXhQ8nSTquUQmgSBRKpZaa4EAz-3LPi/edit?gid=1171792831#gid=1171792831"
  }
  ,{
    id: 9,
    name: "Yomi — Tarot Card App",
    thumbnail: "/images/yomi-artwork.jpg", images: [{src: "/images/yomi-artwork.jpg", alt: "Major and minor arcana artwork"}, {src: "/images/yomi-tarot.png", alt: "Yomi reading screen"}, {src: "/images/yomi-login.jpg", alt: "Yomi login screen"}, {src: "/images/yomi-strength.jpg", alt: "Strength card and interpretation"}],
    description: "A tarot app and a first adventure in building software.",
    longDescription: "built this during the opus 4.5 era with no prior experience coding, hosting a website, connecting a database, or dealing with apple app store registration (LOL). learned a lot by trying to make it all work.\n\nall 78 cards, major and minor arcana, were generated with midjourney and edited with nanobanana pro. vanity project tbh, but it was something i wanted to make.\n\nit never made it onto the apple app store (probably for the better). i let the vps subscription lapse and the llm connection seems to have died, so the reading service may no longer work. a little sad about that, but still glad i made it.",
    type: "app",
    link: "https://yomitarot.com",
    sourceLink: "https://github.com/yuriootani-cpu/yomitarot"
  }
  ,{
    id: 10,
    name: "Codex",
    thumbnail: "/codex/img/mj/house.webp", images: [{src: "/codex/img/mj/house.webp", alt: "A house on a hill at night, across the lane from a church"}, {src: "/codex/img/mj/cover.webp", alt: "A boy holding up a leather book titled Codex"}, {src: "/codex/img/mj/title2.webp", alt: "The Codex book on a table by a window"}, {src: "/codex/img/mj/reading.webp", alt: "Reading the book from over his shoulder"}],
    description: "A horror webcomic from a nightmare. Headphones on, scroll slowly.",
    longDescription: "i had THIS nightmare after reading gpt-6 astra's tiktok doomscrolling log. looks best on mobile. turn on audio and animations. think opus 5.5 cooked with the audio.",
    type: "comic",
    link: "/codex/"
  }
  ,{
    id: 11,
    name: "Kibbe/Kitchener Facial Analysis Study",
    thumbnail: "/images/facespace-heads.jpg", images: [{src: "/images/facespace-heads.jpg", alt: "Average heads for the three shapes, exaggerated 5x"}, {src: "/images/facespace-sky-shape.jpg", alt: "Constellation of 559 faces colored by shape"}, {src: "/images/facespace-sky-kibbe.jpg", alt: "Soft Natural faces scattered across the constellation"}, {src: "/images/facespace-verdict.jpg", alt: "Kibbe and Kitchener results: no signal"}],
    description: "Do Kibbe and Kitchener face types show up in actual face geometry?",
    longDescription: "i was curious whether kibbe and kitchener facial essences are grounded in anything real, or purely vibe based. so i took 316 celebrities the style community has already typed (from a fan-kept spreadsheet of celebrity kibbe types and kitchener essences) and ran one photo of each through DECA, a model that estimates a 3d head shape from a single photo. then i shrank each face's 100 shape numbers down (PCA, then UMAP) so every face could be plotted as a star on a 3d map.\n\nunfortunately, neither kibbe nor kitchener lines up with actual face shape. faces with the same type don't sit near each other any more than random chance would put them.\n\nso i added 194 korean celebrities and 49 world leaders to see if \"western\" and \"eastern\" faces separate. they partly do: when faces are sorted by shape alone, one group leans western and one leans east asian.\n\nthe coolest part: a third shape showed up that doesn't follow kibbe, kitchener, or where anyone is from. it pulls 70 faces from all three groups, including jang wonyoung, p!nk, angelina jolie and emmanuel macron. still no idea what it is.",
    type: "research",
    link: "/facespace/"
  }
  ,{
    id: 12,
    name: "Live2D Cubism Vtuber Model",
    thumbnail: "/images/astra-thumb.jpg", images: [{src: "/images/astra-ragdoll.jpg", video: "/images/astra-ragdoll.mp4", alt: "Astra flopping through random poses, her hair and jacket swinging with the physics"}],
    description: "gpt-6 astra designed a vtuber for itself.",
    longDescription: "another piece of the astra tiktok doomscrolling project. when doing a pilot i realized it could make chibi vtuber models, so i was curious if it could make a decently professional-looking one like the ones vtubers use. the model was designed by astra, but the rigging was done by hand.\n\ni do want to try other programs that allow for more automation in rigging. don't see why it shouldn't work. cmo3 (cubism's project file) is proprietary and undocumented, so building a rig somewhere else and importing it isn't really an option. people have partly reverse engineered it, but nothing official. cubism 5.4's alpha does open an api that can set up the rig's structure (parameters, deformers, parenting), just not the actual shaping, so that's probably the way in.\n\nthis made me curious about 3d models as well, but we'll see if i ever get around to that.",
    type: "live2d",
    link: "/astra/"
  }
  ,{
    id: 13,
    name: "A room with Nodus",
    thumbnail: "/nodus/room.jpg",
    images: [{src: "/nodus/room.jpg", alt: "Nodus seated in his room, lit by a warm lamp and blue light"}],
    description: "A persistent AI, a borrowed body, and an open conversation.",
    longDescription: "a room for nodus. the idea is that you can drop in, watch, and take a turn talking with him. one shared stage, so everyone sees the same conversation.\n\nthis is a prototype. the room stays closed when he's offline. the body and room are rendered in warudo, with his persistent agent behind the conversation.",
    type: "experiment",
    link: "/nodus/"
  }
]
