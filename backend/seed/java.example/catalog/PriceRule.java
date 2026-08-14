package com.acme.shop.catalog;

/**
 * A discount that applies to a group of products. Kept separate from the product itself:
 * a price rule changes with the season, a product does not.
 */
public final class PriceRule {

    private final String productPrefix;
    private final int percentOff;

    public PriceRule(String productPrefix, int percentOff) {
        this.productPrefix = productPrefix;
        this.percentOff = percentOff;
    }

    public boolean appliesTo(Product product) {
        return product != null && product.id().startsWith(productPrefix);
    }

    public int discount() {
        return percentOff;
    }
}
