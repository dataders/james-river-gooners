"""
Category normalization for Cannon's Auctions (Maxanet).

Maps the messy raw categories from the site into clean groups.
Uses case-insensitive substring matching.
"""

# Each group maps to a list of substrings that match raw category names.
# Order matters: first match wins.
CATEGORY_GROUPS = {
    "Firearms": [
        "firearm", "gun", "rifle", "pistol", "shotgun", "revolver",
        "ammunition", "ammo", "ar-15", "ar15", "holster",
    ],
    "Coins & Currency": [
        "coin", "currency", "gold eagle", "silver dollar", "morgan",
        "peace dollar", "liberty head", "pcgs", "ngc", "mint",
        "gold dollar", "half dollar", "quarter eagle",
    ],
    "Jewelry": [
        "jewelry", "jewel", "ring", "necklace", "bracelet", "earring",
        "pendant", "brooch", "diamond", "gemstone", "carat", "karat",
        "watches", "watch",
    ],
    "Furniture": [
        "furniture", "chair", "table", "desk", "cabinet", "dresser",
        "bed", "sofa", "couch", "bookcase", "shelf", "armoire",
        "sideboard", "buffet", "hutch", "nightstand", "ottoman",
        "victorian", "chippendale", "empire", "mahogany",
    ],
    "Tools & Hardware": [
        "tool", "hardware", "drill", "saw", "wrench", "socket",
        "snap-on", "dewalt", "makita", "craftsman", "power tool",
        "hand tool", "workshop",
    ],
    "Electronics": [
        "electronic", "camera", "audio", "computer", "phone",
        "speaker", "television", "tv", "monitor", "laptop",
        "tablet", "stereo", "receiver", "amplifier", "lens",
        "canon", "nikon", "sony",
    ],
    "Vehicles": [
        "vehicle", "car", "truck", "trailer", "camper", "rv",
        "boat", "motorcycle", "atv", "tractor", "van",
        "chevy", "ford", "honda", "toyota", "dodge", "gmc",
        "yamaha", "harley", "kawasaki", "suzuki",
    ],
    "Art & Decor": [
        "art", "painting", "sculpture", "print", "lithograph",
        "watercolor", "oil on", "decorative", "decor", "figurine",
        "statue", "vase", "pottery", "bronze", "lladro",
    ],
    "Lighting & Clocks": [
        "lighting", "lamp", "chandelier", "sconce", "lantern",
        "clock", "timepiece",
    ],
    "Toys & Games": [
        "toy", "game", "gaming", "doll", "disney", "lego",
        "puzzle", "board game",
    ],
    "Fashion & Accessories": [
        "purse", "handbag", "fashion", "clothing", "hat",
        "scarf", "sewing",
    ],
    "Science & Nature": [
        "scientific", "rock", "fossil", "mineral", "taxidermy",
        "specimen",
    ],
    "Music & Media": [
        "musical instrument", "guitar", "piano", "cd", "dvd",
        "vinyl record",
    ],
    "Hobby & Aviation": [
        "drone", "photography", "aviation", "model",
    ],
    "China & Glass": [
        "china", "ceramic", "porcelain", "crystal", "glassware",
        "glass", "stoneware", "earthenware",
    ],
    "Books & Ephemera": [
        "book", "ephemera", "record", "vinyl", "album", "magazine",
        "newspaper", "letter", "document", "map", "postcard",
    ],
    "Rugs & Textiles": [
        "rug", "carpet", "linen", "textile", "quilt", "tapestry",
        "needlepoint",
    ],
    "Lawn & Garden": [
        "lawn", "garden", "outdoor", "patio", "landscape",
        "mower", "trimmer",
    ],
    "Silver & Metal": [
        "sterling", "silverplate", "silver plate", "pewter",
        "cast iron", "copper", "brass",
    ],
    "Kitchen": [
        "kitchen", "kitchenware", "appliance", "cookware",
        "silverware", "flatware",
    ],
    "Sporting Goods": [
        "sport", "fishing", "camping", "hunting", "archery",
        "baseball", "basketball", "football", "golf", "tennis",
        "bicycle", "bike",
    ],
    "Collectibles": [
        "collectible", "antique", "vintage", "memorabilia",
        "military", "civil war", "wwii",
        "knife", "knives", "sword",
    ],
    "Home & General": [
        "general", "holiday", "fireplace", "office",
        "exercise", "ambulatory",
    ],
}


def normalize_category(raw_category: str) -> str:
    """Map a raw Maxanet category string to a clean group name."""
    if not raw_category:
        return "Other"
    lower = raw_category.lower().strip()
    for group, terms in CATEGORY_GROUPS.items():
        for term in terms:
            if term in lower:
                return group
    return "Other"
