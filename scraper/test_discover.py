import unittest

from discover import extract_auction_item_urls


class DiscoverAuctionUrlsTest(unittest.TestCase):
    def test_extracts_and_deduplicates_item_urls_from_auction_cards(self):
        html = """
        <a onclick='LoadAcutionItemList("/Public/Auction/AuctionItems?AuctionId=XgTddU43tCQrk0%2fgjgUuBA%3d%3d&amp;Title=abc&amp;pageNumber=one")'>View Items</a>
        <a onclick='LoadAcutionItemList("/Public/Auction/AuctionItems?AuctionId=XgTddU43tCQrk0%2fgjgUuBA%3d%3d&amp;Title=abc&amp;pageNumber=one")'>View Items</a>
        <a href="/Public/Auction/AuctionItems?AuctionId=NxlGR1rzSa43pZm8BUveUQ%3d%3d&amp;Title=def&amp;pageNumber=two">View Items</a>
        """

        urls = extract_auction_item_urls(html)

        self.assertEqual(
            urls,
            [
                "https://bid.cannonsauctions.com/Public/Auction/AuctionItems?AuctionId=XgTddU43tCQrk0%2fgjgUuBA%3d%3d&Title=abc&pageNumber=one",
                "https://bid.cannonsauctions.com/Public/Auction/AuctionItems?AuctionId=NxlGR1rzSa43pZm8BUveUQ%3d%3d&Title=def&pageNumber=two",
            ],
        )


if __name__ == "__main__":
    unittest.main()
