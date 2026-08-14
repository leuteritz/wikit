package com.acme.shop.catalog;

import com.acme.shop.util.Money;

/** One sellable article: an id, a name, and what it costs before any rule applies. */
public final class Product {

    private final String id;
    private final String name;
    private final Money basePrice;

    public Product(String id, String name, Money basePrice) {
        this.id = id;
        this.name = name;
        this.basePrice = basePrice;
    }

    public String id() {
        return id;
    }

    public String name() {
        return name;
    }

    public Money basePrice() {
        return basePrice;
    }
}
