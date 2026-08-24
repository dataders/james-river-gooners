import scrape_fredwilson


def test_city_from_tag_line_without_state_defaults_to_virginia():
    auction = {"location": None, "tag_line": "Located in Newport News"}

    assert scrape_fredwilson._city_from_auction(auction) == ("Newport News", "VA")


def test_city_from_description_still_requires_explicit_state():
    auction = {
        "location": None,
        "tag_line": "",
        "description": "Equipment located in Hampton, VA",
    }

    assert scrape_fredwilson._city_from_auction(auction) == ("Hampton", "VA")
