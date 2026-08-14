package com.acme.shop.catalog;

import com.acme.shop.util.Money;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Everything that can be sold, and what it currently costs. The price rules live here
 * and not on the product, so a rule change touches one place instead of every article.
 */
public class ProductCatalog {

    private final Map<String, Product> products = new HashMap<>();
    private final List<PriceRule> rules = new ArrayList<>();

    public void register(Product product, PriceRule rule) {
        products.put(product.id(), product);
        if (rule != null) {
            rules.add(rule);
        }
    }

    public Product find(String productId) {
        return products.get(productId);
    }

    /** The price after every matching rule — this is what an order line is charged. */
    public Money effectivePrice(String productId) {
        Product product = find(productId);
        if (product == null) {
            throw new IllegalArgumentException("Unknown product: " + productId);
        }
        long cents = product.basePrice().amount();
        for (PriceRule rule : rules) {
            if (rule.appliesTo(product)) {
                cents = cents - (cents * rule.discount() / 100L);
            }
        }
        return Money.of(cents, "EUR");
    }

    public int size() {
        return products.size();
    }
}
