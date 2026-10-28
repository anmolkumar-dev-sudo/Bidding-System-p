require("dotenv").config();

const crypto = require("node:crypto");
const readline = require("node:readline/promises");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const User = require("../src/controllers/Users");
const Product = require("../src/models/Product");
const Bid = require("../src/models/Bid");

const SEED_PREFIX = "bidroom-demo-v1";
const EMAIL_DOMAIN = "demo.bidroom.invalid";
const DAY = 24 * 60 * 60 * 1000;

// Unsplash photos are representative category images. Model-specific reference
// photos below are real photographs from Wikimedia Commons, never generated.
const photoIds = {
  audio: ["1505740420928-5e560c06d30e", "1546435770-a3e426bf472b", "1590658268037-6bf12165a8df", "1484704849700-f032a568e944", "1583394838336-acd977736f90", "1505538810643-b5bdb714032a"],
  phones: ["1511707171634-5f897ff02aa9", "1512499617640-c74ae3a79d37", "1557774058-c9148bc6e481", "1510557880182-3d4d3cba35a5", "1512941937669-90a1b58e7e9", "1598327105666-5e42825ae85e"],
  laptops: ["1496181133206-80ce9b88a853", "1517336714731-489689fd1ca8", "1498050108023-c5249f4df085", "1588872657578-7efd1f1555ed", "1541807084-5c52b6b3adef", "1525547719571-a2d4ac8945e2"],
  cameras: ["1516035069371-29a1b244cc32", "1502920917128-1aa500764cbd", "1457608135803-4827addc43e0", "1524135220673-c731600a1a50", "1623111740858-ee5e7e24b679", "1562699342-cbc4399aa9ec"],
  watches: ["1523275335684-37898b6baf30", "1524805444758-089113d48a6d", "1434056886845-dac89ffe9b56", "1524592094714-0f0654e20314", "1508685096489-7aacd43bd3b1", "1547996160-81dfa63595aa"],
  sneakers: ["1542291026-7eec264c27ff", "1544441893-675973e31985", "1460353581641-37baddab0fa2", "1552346154-21d32810aba3", "1551107696-a4b0c5a0d9a2", "1600185365483-26d7a4cc7519"],
  apparel: ["1716835239738-5cb4b27341d0", "1739384879592-79903b12b2a6", "1647152777991-4298db91a1f6", "1665990886219-183d3c156c60", "1529139574466-a303027c1d8b", "1483985988355-763728e1935b"],
  bags: ["1553062407-98eeb64c6a62", "1548036328-c9fa89d128fa", "1584917865442-de89df76afd3", "1590874103328-eac38a683ce7", "1547949003-9792a18a2601", "1553062407-98eeb64c6a62"],
  jewelry: ["1611652022419-a9419f74343d", "1617038220319-276d3cfab638", "1599643478518-a784e5dc4c8f", "1611591437281-460bfbe1220a", "1515562141207-7a88fb7ce338", "1611652022419-a9419f74343d"],
  furniture: ["1503602642458-232111445657", "1555041469-a586c61ea9bc", "1493663284031-b7e3aefcae8e", "1608811579303-9f050d3216de", "1600210492486-724fe5c67fb0", "1616486338812-3dadae4b4ace"],
  decor: ["1616486029423-aaa4789e8c9a", "1618221195710-dd6b41faaea6", "1615874694520-474822394e73", "1600210492486-724fe5c67fb0", "1616486338812-3dadae4b4ace", "1616486029423-aaa4789e8c9a"],
  bicycles: ["1485965120184-e220f721d03e", "1571068316344-75bc76f77890", "1507035895480-2f3f23fabe5b", "1511994298241-608e28f14fde", "1495592822105-4ffad56c1b5a", "1571068316344-75bc76f77890"],
  guitars: ["1510915361894-db8b60106cb1", "1524368535928-5b5e00ddc76b", "1511379938547-c1f69419868d", "1461360228754-6e81c478b882", "1510915361894-db8b60106cb1", "1524368535928-5b5e00ddc76b"],
  kitchen: ["1556911220-e15b29be8c8f", "1556909114-f6e7ad7d3136", "1556912172-45b7abe8b7e1", "1490645935967-10de6ba17061", "1556911220-e15b29be8c8f", "1556909114-f6e7ad7d3136"],
  vehicles: ["1687342063225-f5e85f93c1e4", "1751583278667-9b27c32d01ea", "1492144534655-ae79c964c9d7", "1503376780353-7e6692767b70", "1503736334956-4c8f8e92946d", "1503376780353-7e6692767b70"]
};

const groups = [
  { category: "audio", label: "wireless audio", titles: ["Sony WH-1000XM5 Wireless Headphones", "Bose QuietComfort 45 Headphones", "Sennheiser Momentum 4 Wireless", "Audio-Technica ATH-M50x Studio Headphones"] },
  { category: "phones", label: "smartphone", titles: ["Apple iPhone 13, 128 GB", "Samsung Galaxy S22, 256 GB", "Google Pixel 7 Pro", "OnePlus 11 5G, 256 GB"] },
  { category: "laptops", label: "laptop", titles: ["MacBook Air M1, 8 GB / 256 GB", "Dell XPS 13 Ultrabook", "Lenovo ThinkPad X1 Carbon", "ASUS ZenBook 14 OLED"] },
  { category: "cameras", label: "camera", titles: ["Fujifilm X-T30 Mirrorless Camera", "Canon EOS 90D DSLR Body", "Sony Alpha a6400 Camera Kit", "Olympus OM-D E-M10 Mark IV"] },
  { category: "watches", label: "wristwatch", titles: ["Seiko 5 Sports Automatic Watch", "Citizen Eco-Drive Chronograph", "Casio G-Shock 5600 Series", "Timex Marlin Automatic 40 mm"] },
  { category: "sneakers", label: "pair of sneakers", titles: ["Nike Air Max 90, Men's Size 9", "Adidas Ultraboost 22, Men's Size 10", "New Balance 990v5, Men's Size 8.5", "Converse Chuck 70 High Tops, Size 7"] },
  { category: "apparel", label: "clothing piece", titles: ["Levi's Trucker Denim Jacket, Size M", "Patagonia Better Sweater Fleece, Size L", "Classic Wool Overcoat, Size M", "Handwoven Cotton Saree with Blouse Piece"] },
  { category: "bags", label: "bag", titles: ["Herschel Little America Backpack", "Leather Crossbody Satchel", "Canvas Weekender Travel Duffel", "Fjällräven Kånken Laptop Backpack"] },
  { category: "jewelry", label: "jewelry piece", titles: ["Sterling Silver Chain Bracelet", "Gold-Tone Pendant Necklace", "Handcrafted Gemstone Drop Earrings", "Vintage Silver Signet Ring"] },
  { category: "furniture", label: "furniture piece", titles: ["Mid-Century Oak Lounge Chair", "Solid Teak Side Table", "Compact Writing Desk with Drawer", "Vintage Thonet Bentwood Chair"] },
  { category: "decor", label: "home décor piece", titles: ["Handmade Ceramic Table Lamp", "Framed Botanical Print Set of Three", "Wool Flatweave Accent Rug, 5 × 7 ft", "Vintage Brass Floor Lamp"] },
  { category: "bicycles", label: "bicycle", titles: ["Trek FX 3 Disc Hybrid Bicycle", "Giant Escape 2 City Bike", "Vintage Raleigh Road Bicycle", "Decathlon Riverside Touring Bike"] },
  { category: "guitars", label: "musical instrument", titles: ["Fender Stratocaster Electric Guitar", "Yamaha FG800 Acoustic Guitar", "Epiphone Les Paul Standard", "Casio 61-Key Portable Keyboard"] },
  { category: "kitchen", label: "kitchen appliance", titles: ["KitchenAid Artisan Stand Mixer", "Breville Barista Express Espresso Machine", "Le Creuset Cast-Iron Dutch Oven", "Ninja Professional Blender with Pitcher"] },
  { category: "vehicles", label: "vehicle", titles: ["2014 Honda City V Manual", "2011 Maruti Suzuki Swift VXi", "2013 Royal Enfield Classic 350", "2018 Hyundai i20 Sportz"] }
];

const firstNames = ["Aarav", "Diya", "Kabir", "Anaya", "Reyansh", "Ishita", "Vivaan", "Meera", "Arjun", "Saanvi", "Aditya", "Kiara", "Rohan", "Aadhya", "Dev", "Myra", "Ishaan", "Tara", "Neel", "Aanya", "Kunal", "Riya", "Veer", "Avni", "Samar", "Naina", "Yash", "Mira", "Arnav", "Ira", "Om", "Siya", "Dhruv", "Nisha", "Krish", "Anika", "Rahul", "Pihu", "Aman", "Tia", "Siddharth", "Navya", "Manav", "Zoya", "Ritvik", "Kavya", "Parth", "Ishani", "Varun", "Sana"];
const lastNames = ["Sharma", "Mehta", "Kapoor", "Iyer", "Rao", "Nair", "Patel", "Khanna", "Das", "Malhotra"];
const sellerNames = Array.from({ length: 50 }, (_, i) => `${firstNames[i]} ${lastNames[(i * 7 + 3) % lastNames.length]} · Demo`);
const startingPrices = [
  [8500, 7200, 6800, 7600], [21000, 18500, 22000, 19500], [39000, 32000, 41000, 36000],
  [36000, 44000, 38500, 28000], [9000, 7500, 3200, 11000], [2800, 3500, 4200, 1800],
  [2400, 3200, 4600, 3900], [2800, 3500, 2200, 3000], [1800, 2400, 1600, 2100],
  [12500, 6800, 9500, 8200], [3600, 1800, 4800, 5200], [28000, 24000, 19000, 22000],
  [48000, 6500, 32000, 8500], [18000, 24000, 5800, 6200], [385000, 265000, 145000, 425000]
];

function productCatalog() {
  const notes = [
    "Includes the listed accessories; controls, ports, and moving parts are described as working normally.",
    "The finish has light signs of careful use, with no major cosmetic issue reported in this sample listing.",
    "A well-kept example stored indoors between uses; measurements and additional close-ups can be requested from the seller.",
    "Presented with the included accessories and a clear condition note so bidders can evaluate the item before the closing date."
  ];
  return groups.flatMap((group, groupIndex) => group.titles.map((title, itemIndex) => ({
    title,
    category: group.label,
    photoCategory: group.category,
    groupIndex,
    itemIndex,
    startingPrice: startingPrices[groupIndex][itemIndex],
    details: notes[(groupIndex + itemIndex) % notes.length]
  })));
}

function makeDescription(item) {
  return `${item.title} is a sample ${item.category} listing prepared to demonstrate the Bidroom auction experience. ${item.details} This demo record describes the condition as very good, with light signs of normal use and no major issue reported. Its real reference photos show the named model or a close example of the item type; they are not photos of the exact demo unit. This is simulated portfolio content, not a real seller offer, completed payment, or shipment. Review the starting price, current bid, seller profile, and closing date as you would when evaluating a live auction.`;
}

const referencePhotos = {
  "2014 Honda City V Manual": [
    "2014 Honda City (GM6 MY14) VTi sedan (2015-07-15) 01.jpg",
    "2014 Honda City (GM6 MY14) VTi sedan (2015-07-15) 02.jpg",
    "Honda City 1.5 VX 2014 (5).jpg"
  ],
  "2011 Maruti Suzuki Swift VXi": [
    "Swift 12032015.jpg",
    "Car on the platform.jpg",
    "Maruti Suzuki Swift 4456.JPG"
  ],
  "2013 Royal Enfield Classic 350": [
    "Royal Enfield Classic 350.jpg",
    "Royal Enfield Classic 350 Head Light.JPG",
    "Royal Enfield Classic 350 SideView.JPG"
  ],
  "2018 Hyundai i20 Sportz": [
    "2018 Hyundai i20 facelift Front.jpg",
    "2018 Hyundai i20 facelift Rear.jpg",
    "2018 Hyundai i20 facelift Interior.jpg"
  ],
  "Fender Stratocaster Electric Guitar": [
    "Fender strat.jpg",
    "Fender Stratocaster.jpg",
    "Fender stratocaster.jpg"
  ],
  "Vintage Thonet Bentwood Chair": [
    "BLW Bentwood Chair.jpg",
    "Thonet chairs.jpg",
    "Chair (AM 5758-1).jpg"
  ]
};

function commonsImageUrl(fileName) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}?width=1200`;
}

function listingPhotos(item, listingIndex) {
  const references = referencePhotos[item.title];
  if (references) {
    return references.map((fileName, photoIndex) => ({
      url: commonsImageUrl(fileName),
      cloudinaryId: null,
      storageKey: null,
      alt: `Real reference photo of ${item.title}, view ${photoIndex + 1}`
    }));
  }

  const ids = photoIds[item.photoCategory];
  return Array.from({ length: 3 }, (_, photoIndex) => {
    const id = ids[(listingIndex * 2 + photoIndex) % ids.length];
    return {
      url: `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1000&q=82`,
      cloudinaryId: null,
      storageKey: null,
      alt: `Representative ${item.category} sample photo ${photoIndex + 1} for ${item.title}`
    };
  });
}

function shuffleWithSeed(items) {
  const copy = [...items];
  let seed = 20261024;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function seed() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not configured in server/.env");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmation = await rl.question("This adds 50 demo accounts, 60 demo auctions, and simulated bids. It does not delete existing data. Type seed-demo to continue: ");
  rl.close();
  if (confirmation.trim() !== "seed-demo") throw new Error("Seed cancelled; no database changes were made.");

  await mongoose.connect(process.env.MONGO_URI);
  if (mongoose.connection.name !== "bidding_app") {
    throw new Error(`Connected to unexpected database "${mongoose.connection.name}"; expected "bidding_app". No demo records were written.`);
  }
  const emails = Array.from({ length: 50 }, (_, i) => `seller-${String(i + 1).padStart(2, "0")}@${EMAIL_DOMAIN}`);
  const accounts = [];
  for (let i = 0; i < emails.length; i += 1) {
    const email = emails[i];
    const password = await bcrypt.hash(crypto.randomBytes(32).toString("base64url"), 12);
    const user = await User.findOneAndUpdate(
      { email },
      { $setOnInsert: { name: sellerNames[i], email, password, role: "seller", emailVerified: false, isActive: true } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).select("_id");
    accounts.push(user._id);
  }

  const now = new Date();
  const catalog = shuffleWithSeed(productCatalog());
  const productIds = [];
  const bidRows = [];

  for (let i = 0; i < catalog.length; i += 1) {
    const item = catalog[i];
    const isActive = i < 50;
    const sellerIndex = isActive ? i : (i - 50) % 10;
    const bidCount = isActive ? 1 + (i % 6) : 5 + (i % 7);
    const step = Math.max(100, Math.round(item.startingPrice * 0.035 / 100) * 100);
    const createdAt = isActive
      ? new Date(now.getTime() - (1 + (i % 20)) * DAY)
      : new Date(now.getTime() - (8 + (i % 30)) * DAY);
    const endsAt = isActive
      ? new Date(now.getTime() + (7 + ((i * 7) % 24)) * DAY)
      : new Date(now.getTime() - (1 + (i % 20)) * DAY);
    const currentPrice = item.startingPrice + bidCount * step;
    const winnerIndex = (sellerIndex + bidCount + (i % 13)) % 50;
    const demoSeedId = `${SEED_PREFIX}-${String(i + 1).padStart(3, "0")}`;
    const saved = await Product.findOneAndUpdate(
      { demoSeedId },
      {
        $set: {
          demoSeedId,
          title: item.title,
          description: makeDescription(item),
          images: listingPhotos(item, item.groupIndex * 4 + item.itemIndex),
          startingPrice: item.startingPrice,
          currentPrice,
          adminId: accounts[sellerIndex],
          status: isActive ? "active" : "sold",
          endsAt,
          winnerId: isActive ? null : accounts[winnerIndex],
          bidCount,
          createdAt,
          updatedAt: isActive ? now : endsAt
        }
      },
      { upsert: true, new: true, runValidators: true, timestamps: false }
    ).select("_id");
    productIds.push(saved._id);

    for (let j = 0; j < bidCount; j += 1) {
      const bidderIndex = (sellerIndex + 1 + j + (i % 13)) % 50;
      const bidWindowEnd = isActive ? now : endsAt;
      const interval = Math.max(1, bidWindowEnd.getTime() - createdAt.getTime());
      const placedAt = new Date(createdAt.getTime() + Math.floor(interval * (j + 1) / (bidCount + 1)));
      bidRows.push({
        productId: saved._id,
        userId: accounts[bidderIndex],
        amount: item.startingPrice + (j + 1) * step,
        createdAt: placedAt,
        updatedAt: placedAt
      });
    }
  }

  // Only bid records attached to these marked demo listings are replaced.
  await Bid.deleteMany({ productId: { $in: productIds } });
  await Bid.insertMany(bidRows, { ordered: true });
  const demoFilter = { demoSeedId: { $regex: `^${SEED_PREFIX}-` } };
  const activeCount = await Product.countDocuments({ ...demoFilter, status: "active" });
  const soldCount = await Product.countDocuments({ ...demoFilter, status: "sold" });
  console.log(`Demo seed complete: ${activeCount} active auctions, ${soldCount} sold auctions, ${accounts.length} demo accounts, ${bidRows.length} simulated bids.`);
  console.log("Demo accounts use reserved .invalid emails and are unverified. Photos are real model/category references, not photos of the exact demo units.");
}

seed()
  .catch((error) => {
    console.error("Demo seed stopped:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
